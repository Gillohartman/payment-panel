import { auth, db, origin, mailReady } from "./auth";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  CHECKS_PER_INTERVAL, CHECK_GAP_MS, CHECK_INTERVAL_MINUTES, payCommand, purge, recordPayment, redeem, session,
  tiers,
} from "./licensing";

export const MAX_CONFIG = 5_000_000;
const privateHeaders = { "Cache-Control": "private, no-store" };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: privateHeaders });
const error = (message: string, status: number) => json({ error: message }, status);
const rate = new Map<string, { n: number; until: number }>();
function limited(req: Request) {
  const key = req.headers.get("x-revolution-rate-key") ?? "local";
  const now = Date.now();
  if (rate.size > 1000) for (const [k, v] of rate) if (v.until < now) rate.delete(k);
  const entry = rate.get(key);
  if (!entry || entry.until < now) { rate.set(key, { n: 1, until: now + 60000 }); return false; }
  return ++entry.n > 120;
}
export async function bounded(req: Request, max: number) {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > max) throw new RangeError("Upload is too large.");
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new RangeError("Upload is too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
export function validateConfig(text: string) {
  const parsed = JSON.parse(text);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !parsed.modules || Array.isArray(parsed.modules) || typeof parsed.modules !== "object") throw new Error("Expected a Revolution profile JSON object with modules.");
  // Transfer only known config data, never arbitrary file data, credentials or media blobs.
  const allowed = new Set(["configVersion", "modules", "macros"]);
  if (Object.keys(parsed).some(key => !allowed.has(key))) throw new Error("Only configVersion, modules and macros can be synced.");
  if (Object.keys(parsed.modules).length > 500) throw new Error("Too many modules.");
  for (const [id, mod] of Object.entries(parsed.modules) as [string, any][]) {
    if (!/^[a-z0-9_]{1,80}$/.test(id) || !mod || Array.isArray(mod) || typeof mod !== "object") throw new Error("Invalid module.");
    if (Object.keys(mod).some(key => !["enabled", "key", "settings"].includes(key))) throw new Error("Invalid module fields.");
    if (mod.enabled !== undefined && typeof mod.enabled !== "boolean") throw new Error("Invalid enabled value.");
    if (mod.key !== undefined && (!Number.isInteger(mod.key) || mod.key < -1 || mod.key > 400)) throw new Error("Invalid keybind.");
    if (mod.settings && (Array.isArray(mod.settings) || typeof mod.settings !== "object")) throw new Error("Invalid settings.");
  }
  function walk(value: unknown, depth = 0) {
    if (depth > 8) throw new Error("Config nesting limit exceeded.");
    if (typeof value === "string" && (value.length > 100000 || /^data:|-----BEGIN|Bearer\s/i.test(value))) throw new Error("Config cannot contain embedded media or credentials.");
    if (value && typeof value === "object") for (const [key, v] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid key."); walk(v, depth + 1);
    }
  }
  walk(parsed); return parsed;
}
async function identity(req: Request) {
  const bearer = req.headers.get("authorization");
  if (bearer) {
    const row = db.query("SELECT user_id FROM device_tokens WHERE token_hash=? AND expires>?").get(sha(bearer.replace(/^Bearer /, "")), Date.now()) as { user_id: string } | null;
    if (!row) return null;
    const user = db.query('SELECT id,email,emailVerified FROM "user" WHERE id=?').get(row.user_id) as { id: string; email: string; emailVerified: number } | null;
    return user?.emailVerified ? { id: user.id, email: user.email, device: true } : null;
  }
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user.emailVerified || !session.user.twoFactorEnabled) return null;
  return { id: session.user.id, email: session.user.email, device: false };
}
const isAdmin = (email: string) => Boolean(process.env.ADMIN_EMAIL) && email.toLowerCase() === process.env.ADMIN_EMAIL?.trim().toLowerCase();

export async function api(req: Request): Promise<Response> {
  const url = new URL(req.url), path = url.pathname;
  try {
    const mutation = !["GET", "HEAD"].includes(req.method);
    if (req.headers.has("origin") && req.headers.get("origin") !== origin) return error("Foreign origin refused.", 403);
    // Browser mutations require Origin. Native pairing polling/start are intentionally public, limited,
    // carry a 256-bit poll secret, and cannot approve a device. Native configs require a bearer token.
    const nativePair = ["/api/device/start", "/api/device/poll"].includes(path);
    // The key system is a native client too, and for the same reason: the mod in game is not a browser, sends no
    // Origin, and would otherwise be refused every POST by the rule below. It is not a hole - these routes
    // require their own shared key, which a page in somebody's browser cannot supply without having been given
    // it - and the foreign-origin check above still applies to them, so a page *can* still not post cross-origin.
    const licensing = path.startsWith("/api/license/");
    if (mutation && !nativePair && !licensing && !req.headers.has("authorization") && req.headers.get("origin") !== origin) return error("Same-origin request required.", 403);
    if (limited(req)) return error("Please wait before trying again.", 429);
    if (path === "/api/status") return json({ mailReady, name: "Revolution Client" });
    if (path.startsWith("/api/auth/")) {
      if (path.includes("/two-factor/disable") || path.includes("/sign-in/email-otp") || path.includes("/sign-in/social") || path.includes("/two-factor/verify-backup-code")) return error("Password and email second factor are mandatory.", 403);
      if (mutation && !mailReady && !path.endsWith("/sign-out")) return error("Email delivery is not configured yet.", 503);
      return auth.handler(req);
    }
    if (path === "/api/news" && req.method === "GET") return json(db.query("SELECT id,title,body,created_at FROM news ORDER BY created_at DESC LIMIT 30").all());
    if (path === "/api/releases" && req.method === "GET") return json(db.query("SELECT id,version,notes,created_at FROM releases ORDER BY created_at DESC LIMIT 30").all());
    if (path.startsWith("/api/download/") && req.method === "GET") {
      const id = path.slice("/api/download/".length);
      const release = db.query("SELECT version,path FROM releases WHERE id=?").get(id) as { version: string; path: string } | null;
      if (!release) return error("Release not found.", 404);
      return new Response(Bun.file(release.path), { headers: { "Content-Type": "application/java-archive", "Content-Disposition": `attachment; filename="revolutionclient-${release.version}.jar"`, "X-Content-Type-Options": "nosniff" } });
    }
    if (path === "/api/device/start" && req.method === "POST") {
      db.query("DELETE FROM devices WHERE expires<?").run(Date.now());
      const pollSecret = token(), code = randomBytes(5).toString("hex").toUpperCase();
      db.query("INSERT INTO devices VALUES(?,?,NULL,?)").run(sha(pollSecret), code, Date.now() + 600000);
      return json({ pollSecret, code, verificationUrl: `${origin}/?device=${code}`, expiresIn: 600 });
    }
    if (path === "/api/device/poll" && req.method === "POST") {
      const body = JSON.parse(new TextDecoder().decode(await bounded(req, 2048)));
      const hash = sha(String(body.pollSecret));
      const pair = db.query("SELECT user_id,expires FROM devices WHERE poll_hash=?").get(hash) as { user_id: string | null; expires: number } | null;
      if (!pair || pair.expires < Date.now()) return error("Pairing expired.", 410);
      if (!pair.user_id) return json({ pending: true }, 202);
      const accessToken = token();
      db.transaction(() => {
        db.query("DELETE FROM devices WHERE poll_hash=?").run(hash);
        db.query("INSERT INTO device_tokens VALUES(?,?,?)").run(sha(accessToken), pair.user_id!, Date.now() + 7 * 86400000);
      })();
      return json({ accessToken, expiresIn: 604800 });
    }
    // ------------------------------------------------------------------ the key system
    // These are the three things a running client says. They are not session routes: a client in game has no
    // browser cookie and no account, so it carries a shared key instead - and the payment report carries a
    // second, separate key, because being allowed to run the client is not the same thing as being allowed to
    // tell the server that money moved. A leaked client key cannot mint anything; a leaked watcher key mints
    // only against orders that are already open, for the amount they asked for, inside the window.
    if (path.startsWith("/api/license/")) {
      const clientKey = req.headers.get("x-license-key") ?? "";
      const watchKey = req.headers.get("x-license-watch") ?? "";
      const isClient = Boolean(process.env.LICENSE_API_KEY) && clientKey === process.env.LICENSE_API_KEY;
      const isWatcher = Boolean(process.env.LICENSE_WATCH_KEY) && watchKey === process.env.LICENSE_WATCH_KEY;
      // Public on purpose: the tiers are on the panel anyone can see, and a client needs the check-in schedule
      // before it has a code. Nothing here is private - no code, no customer, no session.
      if (path === "/api/license/info" && req.method === "GET") {
        return json({
          tiers: tiers(db).map(tier => ({ id: tier.id, label: tier.label, days: tier.days, price: tier.price })),
          checkEveryMinutes: CHECK_INTERVAL_MINUTES, checks: CHECKS_PER_INTERVAL, gapMs: CHECK_GAP_MS,
          pay: payCommand("{amount}", "{ign}"),
        });
      }
      if (!isClient && !isWatcher) return error("Licence key required.", 401);
      if (path === "/api/license/session" && req.method === "POST") {
        const body = JSON.parse(new TextDecoder().decode(await bounded(req, 4096)));
        if (typeof body.hwid !== "string" || body.hwid.length < 8) return error("Client id required.", 400);
        // An empty answer to a check-in is success, not failure: "still licensed" is what the panel shows, and a
        // 4xx here would make a working client look like a broken one in every log on the way.
        return json(session(db, {
          hwid: body.hwid, ign: typeof body.ign === "string" ? body.ign.slice(0, 16) : null,
          token: typeof body.token === "string" ? body.token.slice(0, 64) : null,
          countReport: body.countReport === true,
        }));
      }
      if (path === "/api/license/redeem" && req.method === "POST") {
        const body = JSON.parse(new TextDecoder().decode(await bounded(req, 4096)));
        if (typeof body.hwid !== "string" || typeof body.token !== "string") return error("Client id and code required.", 400);
        return json(redeem(db, { token: body.token.slice(0, 64), hwid: body.hwid, ign: typeof body.ign === "string" ? body.ign.slice(0, 16) : null }));
      }
      if (path === "/api/license/payment" && req.method === "POST") {
        if (!isWatcher) return error("This client is not allowed to report payments.", 403);
        const body = JSON.parse(new TextDecoder().decode(await bounded(req, 4096)));
        if (typeof body.ign !== "string" || typeof body.amount !== "number") return error("A payment needs a name and an amount.", 400);
        const result = recordPayment(db, {
          ign: body.ign.slice(0, 16), amount: body.amount,
          raw: typeof body.raw === "string" ? body.raw : "", reporter: sha(clientKey || watchKey).slice(0, 16),
        });
        return json({
          matched: result.matched, reason: result.reason,
          token: result.token?.token ?? null, tier: result.token?.tier ?? null, days: result.token?.days ?? null,
        });
      }
      if (path === "/api/license/purge" && req.method === "POST" && isWatcher) return json(purge(db));
      return error("Not found.", 404);
    }
    const user = await identity(req);
    if (!user) return error("Sign in with password and email code first.", 401);
    if (path === "/api/me") return json({ email: user.email, admin: !user.device && isAdmin(user.email) });
    if (path === "/api/device/approve" && req.method === "POST" && !user.device) {
      const { code } = JSON.parse(new TextDecoder().decode(await bounded(req, 1024)));
      const result = db.query("UPDATE devices SET user_id=? WHERE code=? AND expires>? AND user_id IS NULL").run(user.id, String(code), Date.now());
      return result.changes === 1 ? json({ approved: true }) : error("Invalid or expired device code.", 400);
    }
    if (path === "/api/device/revoke" && req.method === "POST") {
      if (user.device) db.query("DELETE FROM device_tokens WHERE token_hash=?").run(sha(req.headers.get("authorization")!.slice(7)));
      else db.query("DELETE FROM device_tokens WHERE user_id=?").run(user.id);
      return json({ revoked: true });
    }
    if (path === "/api/config") {
      const current = db.query("SELECT body,revision,updated_at FROM configs WHERE user_id=?").get(user.id) as { body: string; revision: number; updated_at: string } | null;
      if (req.method === "GET") return current ? json({ config: JSON.parse(current.body), revision: current.revision, updatedAt: current.updated_at }) : json({ config: null, revision: 0 });
      if (req.method === "PUT") {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await bounded(req, MAX_CONFIG));
        const config = validateConfig(text);
        const revision = Number(req.headers.get("if-match"));
        if (!req.headers.has("if-match") || !Number.isInteger(revision)) return error("Config revision required.", 428);
        const next = revision + 1, updated = new Date().toISOString();
        const success = db.transaction(() => {
          const saved = db.query("SELECT revision FROM configs WHERE user_id=?").get(user.id) as { revision: number } | null;
          if ((saved?.revision ?? 0) !== revision) return false;
          db.query("INSERT INTO configs VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body,revision=excluded.revision,updated_at=excluded.updated_at").run(user.id, JSON.stringify(config), next, updated);
          return true;
        })();
        return success ? json({ revision: next, updatedAt: updated }) : error("Cloud config changed. Reload before uploading.", 409);
      }
    }
    if (path.startsWith("/api/admin/")) {
      if (user.device || !isAdmin(user.email)) return error("Admin access denied.", 403);
      if (path === "/api/admin/news" && req.method === "POST") {
        const body = JSON.parse(new TextDecoder().decode(await bounded(req, 100000)));
        if (typeof body.title !== "string" || body.title.length < 1 || body.title.length > 160 || typeof body.body !== "string" || body.body.length > 20000) return error("Invalid news.", 400);
        db.query("INSERT INTO news VALUES(?,?,?,?)").run(crypto.randomUUID(), body.title, body.body, new Date().toISOString());
        return json({ saved: true });
      }
      if (path === "/api/admin/releases" && req.method === "POST") {
        const version = url.searchParams.get("version") ?? "", notes = url.searchParams.get("notes") ?? "";
        if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || notes.length > 2000) return error("Invalid version or notes.", 400);
        const bytes = await bounded(req, 20_000_000);
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) return error("Expected a JAR/ZIP file.", 400);
        const id = crypto.randomUUID(), dir = `${process.env.DATA_DIR ?? "./data"}/releases`, path = `${dir}/${id}.jar`;
        mkdirSync(dir, { recursive: true }); await Bun.write(path, bytes);
        db.query("INSERT INTO releases VALUES(?,?,?,?,?)").run(id, version, notes, path, new Date().toISOString());
        return json({ id, version });
      }
    }
    return error("Not found.", 404);
  } catch (e) {
    if (e instanceof RangeError) return error(e.message, 413);
    if (e instanceof SyntaxError) return error("Invalid JSON.", 400);
    return error(e instanceof Error ? e.message : "Request failed.", 400);
  }
}
