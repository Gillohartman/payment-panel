import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID, createHash } from "node:crypto";

/**
 * The key system: tiers, orders, detected payments, activation codes and the sessions a running client holds.
 *
 * Everything that decides something is here and takes the database as a parameter, so the whole set of rules can
 * be driven by a test without a Discord connection, a network or a game - which is the only way this can be
 * checked at all, because the bot and the client are both consumers of it.
 *
 * The two halves that are easy to get wrong, and how they are held:
 *
 *   - **A code is used once.** A token is bound to one client on first activation (`hwid`), and a second
 *     activation of the same token is refused rather than moved. Moving it would make one purchase work on
 *     every machine the buyer owns, and refusing it is what makes "it can only be activated once, in this
 *     client" true.
 *   - **A payment is matched, not trusted.** A reported payment only mints a code when it matches an order
 *     that is still open: same in-game name, same amount, and paid inside the window. Anything else is stored
 *     as an unmatched payment for an admin to look at, so a made-up report mints nothing.
 */

/** How long an order stays payable after it is created. The payment has to land inside this. */
export const PAY_WINDOW_MS = Number(process.env.LICENSE_PAY_WINDOW_MINUTES ?? 5) * 60_000;
/** How long a minted code may sit unused before it is deleted. */
export const REDEEM_WINDOW_MS = Number(process.env.LICENSE_REDEEM_WINDOW_DAYS ?? 30) * 86_400_000;
/** How often a running client is expected to check in, in minutes. The client's own loop uses this. */
export const CHECK_INTERVAL_MINUTES = Number(process.env.LICENSE_CHECK_INTERVAL_MINUTES ?? 20);
/** Checks per interval and the gap between them: the client sends this many, this far apart. */
export const CHECKS_PER_INTERVAL = Number(process.env.LICENSE_CHECKS ?? 5);
export const CHECK_GAP_MS = 250;
/** The day a session is considered dead if a client never checked in again, on top of a day of slack. */
const SESSION_SLACK_MS = 86_400_000;

export type Tier = { id: string; label: string; days: number; price: number; pay_amount: string };
export type Order = {
  id: string; discord_id: string; ign: string; tier: string; amount: string;
  status: "open" | "paid" | "cancelled"; channel_id: string | null; message_id: string | null;
  created: number; paid_at: number | null;
};
export type Token = {
  token: string; tier: string; days: number; hwid: string | null; source: "payment" | "trial" | "admin";
  discord_id: string | null; created: number; redeem_by: number; redeemed: number | null;
  license_expires: number | null; revoked: number;
};

const now = () => Date.now();
const code = () => randomBytes(9).toString("hex").toUpperCase().replace(/(.{3})(?=.)/g, "$1-");

/** The in-game name a payment is filed under: case and stray spaces must not decide whether it matches. */
export const normaliseIgn = (ign: string) => ign.trim().toLowerCase();

/** The name a client reports itself under, so one machine is one session and it cannot lie about who it is. */
export const hashHwid = (hwid: string) => createHash("sha256").update(hwid).digest("hex");

export function installLicensing(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lic_tiers (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, days INTEGER NOT NULL,
      price REAL NOT NULL, pay_amount TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS lic_orders (
      id TEXT PRIMARY KEY, discord_id TEXT NOT NULL, ign TEXT NOT NULL, ign_key TEXT NOT NULL,
      tier TEXT NOT NULL, amount TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      channel_id TEXT, message_id TEXT, created INTEGER NOT NULL, paid_at INTEGER);
    CREATE TABLE IF NOT EXISTS lic_payments (
      id TEXT PRIMARY KEY, ign TEXT NOT NULL, ign_key TEXT NOT NULL, amount REAL NOT NULL, raw TEXT NOT NULL,
      reporter TEXT NOT NULL, at INTEGER NOT NULL, order_id TEXT, consumed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS lic_tokens (
      token TEXT PRIMARY KEY, tier TEXT NOT NULL, days INTEGER NOT NULL, hwid TEXT, source TEXT NOT NULL,
      discord_id TEXT, created INTEGER NOT NULL, redeem_by INTEGER NOT NULL, redeemed INTEGER,
      license_expires INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS lic_sessions (
      hwid TEXT PRIMARY KEY, token TEXT NOT NULL, tier TEXT NOT NULL, ign TEXT,
      expires INTEGER NOT NULL, last_seen INTEGER NOT NULL, reports INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS lic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL,
      discord_id TEXT, at INTEGER NOT NULL, posted INTEGER NOT NULL DEFAULT 0, code TEXT);
    CREATE TABLE IF NOT EXISTS lic_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS lic_orders_open ON lic_orders (ign_key, status, created);
    CREATE INDEX IF NOT EXISTS lic_payments_ign ON lic_payments (ign_key, at);
  `);
  // A database made by the build before the code moved into its own column: one statement, once, and quietly
  // skipped when the column is already there. SQLite has no ADD COLUMN IF NOT EXISTS.
  try {
    db.exec("ALTER TABLE lic_events ADD COLUMN code TEXT");
  } catch {
    // already there
  }
  const count = db.query("SELECT COUNT(*) AS n FROM lic_tiers").get() as { n: number };
  if (!count.n) {
    const seed: Tier[] = [
      { id: "trial", label: "1 Day Free Trial", days: 1, price: 0, pay_amount: "0" },
      { id: "monthly", label: "Monthly", days: 30, price: 5, pay_amount: "5" },
      { id: "yearly", label: "Yearly", days: 365, price: 50, pay_amount: "50" },
    ];
    seed.forEach((t, i) => db.run(
      "INSERT INTO lic_tiers (id,label,days,price,pay_amount,position) VALUES (?,?,?,?,?,?)",
      [t.id, t.label, t.days, t.price, t.pay_amount, i]));
  }
}

export const tiers = (db: Database) =>
  db.query("SELECT * FROM lic_tiers ORDER BY position").all() as Tier[];

export function setTier(db: Database, id: string, patch: { days?: number; price?: number; pay_amount?: string; label?: string }) {
  const tier = db.query("SELECT * FROM lic_tiers WHERE id=?").get(id) as Tier | null;
  if (!tier) throw new Error(`Unknown tier ${id}.`);
  db.run("UPDATE lic_tiers SET label=?,days=?,price=?,pay_amount=? WHERE id=?",
    [patch.label ?? tier.label, patch.days ?? tier.days, patch.price ?? tier.price, patch.pay_amount ?? tier.pay_amount, id]);
}

/**
 * The line the buyer is told to paste into the game, e.g. `/pay 5 Steve`.
 *
 * The account being paid is the seller's own in-game name and the placeholder that carries it is
 * `{account}` - one template, set once from the bot, so a change of account is one command and not a code
 * change in two places.
 */
export function payCommand(amount: string, ign: string) {
  const template = process.env.LICENSE_PAY_COMMAND ?? "/pay {amount} {ign}";
  return template.replace("{amount}", amount).replace("{ign}", ign).replace("{account}", process.env.LICENSE_ACCOUNT ?? "");
}

export function createOrder(db: Database, input: { discordId: string; ign: string; tierId: string; channelId?: string | null }): Order {
  const tier = db.query("SELECT * FROM lic_tiers WHERE id=?").get(input.tierId) as Tier | null;
  if (!tier) throw new Error(`Unknown tier ${input.tierId}.`);
  const ign = input.ign.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(ign)) throw new Error("That does not look like a Minecraft name.");
  const order: Order = {
    id: randomUUID(), discord_id: input.discordId, ign, tier: tier.id, amount: tier.pay_amount,
    status: "open", channel_id: input.channelId ?? null, message_id: null, created: now(), paid_at: null,
  };
  db.run(`INSERT INTO lic_orders (id,discord_id,ign,ign_key,tier,amount,status,channel_id,created)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    [order.id, order.discord_id, order.ign, normaliseIgn(order.ign), order.tier, order.amount, "open", order.channel_id, order.created]);
  return order;
}

export const order = (db: Database, id: string) =>
  (db.query("SELECT * FROM lic_orders WHERE id=?").get(id) as Order | null) ?? null;

/** Orders still waiting for their payment, newest first. What the bot shows an admin. */
export const openOrders = (db: Database) =>
  db.query("SELECT * FROM lic_orders WHERE status='open' ORDER BY created DESC").all() as Order[];

export function cancelOrder(db: Database, id: string) {
  db.run("UPDATE lic_orders SET status='cancelled' WHERE id=? AND status='open'", [id]);
}

/**
 * A code the buyer can activate, once.
 *
 * `redeem_by` is the end of the window in which the code may be activated at all, and `license_expires` is
 * filled on activation - the two are different questions: a code that is never used expires, while a licence
 * starts when it is used.
 */
export function mintToken(db: Database, input: { tier: string; days: number; source: Token["source"]; discordId?: string | null }): Token {
  const token: Token = {
    token: code(), tier: input.tier, days: input.days, hwid: null, source: input.source,
    discord_id: input.discordId ?? null, created: now(), redeem_by: now() + REDEEM_WINDOW_MS,
    redeemed: null, license_expires: null, revoked: 0,
  };
  db.run(`INSERT INTO lic_tokens (token,tier,days,source,discord_id,created,redeem_by) VALUES (?,?,?,?,?,?,?)`,
    [token.token, token.tier, token.days, token.source, token.discord_id, token.created, token.redeem_by]);
  queueEvent(db, "minted", `Code minted for ${token.tier} (${token.days}d, ${token.source})`, token.discord_id);
  return token;
}

export function mintForTier(db: Database, tierId: string, source: Token["source"], discordId?: string | null) {
  const tier = db.query("SELECT * FROM lic_tiers WHERE id=?").get(tierId) as Tier | null;
  if (!tier) throw new Error(`Unknown tier ${tierId}.`);
  return mintToken(db, { tier: tier.id, days: tier.days, source, discordId });
}

/**
 * Whether this account has already had its free day.
 *
 * The panel says "1 day, once per account", and until this existed nothing made that true: the button minted a
 * fresh day on every press, and because a second code for the same machine simply extends the session the
 * account already holds, pressing it repeatedly was unlimited free access rather than a trial. The account age
 * gate is the other half of the same promise and cannot carry the rule on its own - an account only gets older.
 *
 * What is counted is what the store still knows. An activated trial is in the table forever, so a used one ends
 * the free day for that account permanently. One that was never activated is deleted when its window closes
 * (`purge`), and an account whose code expired unused is given another turn - which is the reading a buyer who
 * never got to use it would expect.
 */
export const trialUsed = (db: Database, discordId: string) =>
  (db.query("SELECT COUNT(*) AS n FROM lic_tokens WHERE source='trial' AND discord_id=?").get(discordId) as { n: number }).n > 0;

/** A payment reported by a watching client, and what came of it. */
export type PaymentResult = {
  stored: boolean; matched: boolean; reason: string;
  order?: Order; token?: Token;
};

/**
 * Files a payment a client saw, and mints a code when it belongs to an open order.
 *
 * The match is deliberately strict - same name, same amount, inside the window - because this is the one place
 * where a report from a machine turns into a working code. Name comparison is case-insensitive on both sides,
 * and the amount has to match to the cent, since a wrong amount is either a typo or somebody trying to buy a
 * year for a fiver.
 */
export function recordPayment(db: Database, input: { ign: string; amount: number; raw: string; reporter: string; at?: number }): PaymentResult {
  const ign = input.ign.trim();
  const at = input.at ?? now();
  const id = randomUUID();
  if (!ign || !Number.isFinite(input.amount)) {
    db.run(`INSERT INTO lic_payments (id,ign,ign_key,amount,raw,reporter,at,order_id,consumed) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, ign, normaliseIgn(ign), input.amount || 0, input.raw.slice(0, 400), input.reporter, at, null, 0]);
    return { stored: true, matched: false, reason: "The payment was not readable, so it was filed for an admin." };
  }

  const candidate = db.query(`SELECT * FROM lic_orders WHERE ign_key=? AND status='open' AND created>=?
                              ORDER BY created ASC LIMIT 1`)
    .get(normaliseIgn(ign), at - PAY_WINDOW_MS) as Order | null;
  if (!candidate) {
    db.run(`INSERT INTO lic_payments (id,ign,ign_key,amount,raw,reporter,at,order_id,consumed) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, ign, normaliseIgn(ign), input.amount, input.raw.slice(0, 400), input.reporter, at, null, 0]);
    queueEvent(db, "unmatched", `Payment of ${input.amount} from ${ign} matched no open order`, null);
    return { stored: true, matched: false, reason: "No open order for that name inside the payment window." };
  }
  if (Number(candidate.amount) !== Number(input.amount)) {
    db.run(`INSERT INTO lic_payments (id,ign,ign_key,amount,raw,reporter,at,order_id,consumed) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, ign, normaliseIgn(ign), input.amount, input.raw.slice(0, 400), input.reporter, at, null, 0]);
    queueEvent(db, "unmatched", `${ign} paid ${input.amount}, but the order asked for ${candidate.amount}`, candidate.discord_id);
    return { stored: true, matched: false, reason: `The order asks for ${candidate.amount}.` };
  }

  // Paid: the order closes, the payment is filed against it and one code comes out of it. All three together,
  // and the order is claimed before the token is minted, so two clients reporting the same payment at the same
  // instant cannot both mint one.
  const claimed = db.run("UPDATE lic_orders SET status='paid', paid_at=? WHERE id=? AND status='open'", [at, candidate.id]);
  if (!claimed.changes) return { stored: false, matched: false, reason: "That order was already paid." };
  db.run(`INSERT INTO lic_payments (id,ign,ign_key,amount,raw,reporter,at,order_id,consumed) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, ign, normaliseIgn(ign), input.amount, input.raw.slice(0, 400), input.reporter, at, candidate.id, 1]);
  const token = mintForTier(db, candidate.tier, "payment", candidate.discord_id);
  // The code travels in its own field as well as in the sentence: the sentence is what the log channel shows a
  // human, and the field is what the bot DMs to the buyer. Recovery by string surgery is what this replaces.
  queueEvent(db, "paid", `${candidate.ign} paid ${candidate.amount} for ${candidate.tier} - code ${token.token}`,
    candidate.discord_id, token.token);
  return { stored: true, matched: true, reason: "Paid.", order: { ...candidate, status: "paid", paid_at: at }, token };
}

export type RedeemResult =
  | { ok: true; tier: string; expires: number }
  | { ok: false; error: string };

/**
 * Turns a code into a session on one machine.
 *
 * Three refusals, each for its own reason: a code that has already been activated somewhere else (moving it
 * would make one purchase work on every machine the buyer owns), a code past its window, and a revoked one.
 * A code that is activated twice on the *same* machine is not a refusal - that is the buyer reinstalling, and
 * the session is simply extended to the licence that was already granted.
 */
export function redeem(db: Database, input: { token: string; hwid: string; ign?: string | null }): RedeemResult {
  const raw = input.token.trim().toUpperCase();
  const row = db.query("SELECT * FROM lic_tokens WHERE token=?").get(raw) as Token | null;
  if (!row) return { ok: false, error: "That code is not known." };
  if (row.revoked) return { ok: false, error: "That code has been revoked." };
  const hwid = hashHwid(input.hwid);
  const at = now();
  if (row.redeemed !== null) {
    if (row.hwid !== hwid) return { ok: false, error: "That code is already active on another client." };
    const expires = row.license_expires ?? at;
    if (expires <= at) return { ok: false, error: "That code has run out." };
    db.run("UPDATE lic_sessions SET expires=?, last_seen=?, ign=? WHERE hwid=?",
      [expires, at, input.ign ?? null, hwid]);
    return { ok: true, tier: row.tier, expires };
  }
  if (row.redeem_by < at) return { ok: false, error: "That code has expired without being used." };
  const expires = at + row.days * 86_400_000;
  db.run("UPDATE lic_tokens SET hwid=?, redeemed=?, license_expires=? WHERE token=?", [hwid, at, expires, row.token]);
  db.run(`INSERT INTO lic_sessions (hwid,token,tier,ign,expires,last_seen,reports) VALUES (?,?,?,?,?,?,0)
          ON CONFLICT(hwid) DO UPDATE SET token=excluded.token, tier=excluded.tier, ign=excluded.ign,
          expires=excluded.expires, last_seen=excluded.last_seen`,
    [hwid, row.token, row.tier, input.ign ?? null, expires, at]);
  queueEvent(db, "activated", `Code ${row.token} activated ${row.tier} until ${new Date(expires).toISOString()}`, row.discord_id);
  return { ok: true, tier: row.tier, expires };
}

export type SessionResult = {
  active: boolean; tier?: string; expires?: number; ign?: string | null;
  payments?: number; reason?: string;
};

/**
 * What a running client asks for on its check-ins: am I still licensed, and what has been paid in.
 *
 * The payment count is the number of payments matched for the name this session is playing as, which is what
 * the panel in the mod shows. A client that is not licensed is told why in one sentence, so the panel can show
 * the reason rather than a bare "no".
 */
export function session(db: Database, input: { hwid: string; ign?: string | null; token?: string | null; countReport?: boolean }): SessionResult {
  const hwid = hashHwid(input.hwid);
  if (input.token) {
    const activated = redeem(db, { token: input.token, hwid: input.hwid, ign: input.ign });
    if (!activated.ok) return { active: false, reason: activated.error };
  }
  const row = db.query("SELECT * FROM lic_sessions WHERE hwid=?").get(hwid) as
    { hwid: string; token: string; tier: string; ign: string | null; expires: number; last_seen: number; reports: number } | null;
  if (!row) return { active: false, reason: "No code has been activated on this client yet." };
  const tokenRow = db.query("SELECT revoked FROM lic_tokens WHERE token=?").get(row.token) as { revoked: number } | null;
  if (tokenRow?.revoked) return { active: false, reason: "The code this client is using has been revoked." };
  const at = now();
  if (row.expires <= at) return { active: false, tier: row.tier, expires: row.expires, reason: "Your licence has run out." };
  const ign = input.ign ?? row.ign;
  // A check-in is recorded whether or not it counted, so a client that is one version behind still shows up
  // as alive; the *count* of checks is what the panel reads, hence the separate number.
  db.run("UPDATE lic_sessions SET last_seen=?, ign=?, reports=reports+? WHERE hwid=?",
    [at, ign, input.countReport ? 1 : 0, hwid]);
  const payments = ign
    ? (db.query("SELECT COUNT(*) AS n FROM lic_payments WHERE ign_key=?").get(normaliseIgn(ign)) as { n: number }).n
    : 0;
  return { active: true, tier: row.tier, expires: row.expires, ign, payments };
}

/** An admin code: no order, no payment, one code. */
export function adminToken(db: Database, tierId: string, discordId?: string | null) {
  return mintForTier(db, tierId, "admin", discordId);
}

export function revokeToken(db: Database, token: string) {
  const raw = token.trim().toUpperCase();
  const row = db.query("SELECT * FROM lic_tokens WHERE token=?").get(raw) as Token | null;
  if (!row) throw new Error("That code is not known.");
  db.run("UPDATE lic_tokens SET revoked=1 WHERE token=?", [raw]);
  if (row.hwid) db.run("DELETE FROM lic_sessions WHERE hwid=?", [row.hwid]);
  queueEvent(db, "revoked", `Code ${raw} was revoked`, row.discord_id);
}

export const findToken = (db: Database, token: string) =>
  (db.query("SELECT * FROM lic_tokens WHERE token=?").get(token.trim().toUpperCase()) as Token | null) ?? null;

/**
 * The housekeeping pass: codes nobody used are deleted, sessions that stopped checking in are forgotten, and
 * codes close to running out are announced once.
 *
 * Called from the bot's own interval. It is written to be safe to run twice and to do nothing on an empty
 * database, which is what lets it be driven by a test with fixed timestamps rather than a sleep.
 */
export function purge(db: Database, at = now()) {
  const stale = db.run("DELETE FROM lic_tokens WHERE redeemed IS NULL AND redeem_by < ?", [at]);
  const gone = db.run("DELETE FROM lic_sessions WHERE expires + ? < ?", [SESSION_SLACK_MS, at]);
  const spent = db.run("DELETE FROM lic_tokens WHERE revoked=1 AND created < ?", [at - 30 * 86_400_000]);
  // Log lines that have been posted are history, not state: a month of them is plenty to look back over.
  const old = db.run("DELETE FROM lic_events WHERE posted=1 AND at < ?", [at - 30 * 86_400_000]);
  // "It runs out soon" is worth one message, not one a minute: the event is only queued when the token has
  // not been announced before, and the marker that stops the second one is the event itself.
  const soon = db.query(`SELECT * FROM lic_tokens WHERE redeemed IS NOT NULL AND revoked=0
                         AND license_expires BETWEEN ? AND ?`).all(at, at + 3 * 86_400_000) as Token[];
  for (const row of soon) {
    const seen = db.query("SELECT COUNT(*) AS n FROM lic_events WHERE kind='expiring' AND text LIKE ?")
      .get(`%${row.token}%`) as { n: number };
    if (seen.n) continue;
    queueEvent(db, "expiring", `Code ${row.token} (${row.tier}) runs out on ${new Date(row.license_expires ?? 0).toISOString()}`,
      row.discord_id);
  }
  return { tokens: stale.changes + spent.changes, events: old.changes, sessions: gone.changes, expiring: soon.length };
}

/**
 * The outbox.
 *
 * The API writes what happened; the bot reads it and posts it - a log line, a DM, a ticket note. The two are
 * separate because they fail separately: a Discord outage must not stop a payment being recorded, and a bot
 * restart must not lose one. The `posted` flag is the handshake.
 */
export function queueEvent(db: Database, kind: string, text: string, discordId?: string | null, code?: string | null) {
  db.run("INSERT INTO lic_events (kind,text,discord_id,at,code) VALUES (?,?,?,?,?)",
    [kind, text, discordId ?? null, now(), code ?? null]);
}

export function unpostedEvents(db: Database, limit = 20) {
  return db.query("SELECT * FROM lic_events WHERE posted=0 ORDER BY id LIMIT ?").all(limit) as
    { id: number; kind: string; text: string; discord_id: string | null; at: number; code: string | null }[];
}

/**
 * A setting the bot can change at runtime, kept in the database.
 *
 * The environment is how a deployment is configured and stays the first word; this is the second, for the things
 * an admin changes while the bot runs - the log channel is the one that matters, because a setting that lives
 * only in the process is one a redeploy silently undoes.
 */
export function getSetting(db: Database, key: string, fallback = "") {
  const row = db.query("SELECT value FROM lic_settings WHERE key=?").get(key) as { value: string } | null;
  return row?.value ?? fallback;
}

export function setSetting(db: Database, key: string, value: string) {
  db.run("INSERT INTO lic_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);
}

export const markPosted = (db: Database, id: number) => db.run("UPDATE lic_events SET posted=1 WHERE id=?", [id]);

/** What the admin panel shows at a glance. */
export function stats(db: Database) {
  const one = (sql: string, ...args: unknown[]) => (db.query(sql).get(...(args as never[])) as { n: number }).n;
  return {
    tiers: tiers(db),
    open: one("SELECT COUNT(*) AS n FROM lic_orders WHERE status='open'"),
    paid: one("SELECT COUNT(*) AS n FROM lic_orders WHERE status='paid'"),
    unmatched: one("SELECT COUNT(*) AS n FROM lic_payments WHERE consumed=0"),
    codes: one("SELECT COUNT(*) AS n FROM lic_tokens WHERE revoked=0"),
    active: one("SELECT COUNT(*) AS n FROM lic_sessions WHERE expires>?", now()),
    used: one("SELECT COUNT(*) AS n FROM lic_tokens WHERE redeemed IS NOT NULL"),
  };
}

/** Nobody should be able to guess a code from the one next to it, and this is the check that says so. */
export function codeEntropy() {
  const sample = Array.from({ length: 200 }, code);
  return { unique: new Set(sample).size, sample: sample[0]! };
}
