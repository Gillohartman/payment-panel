import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "revolution-web-test-"));
process.env.NODE_ENV = "test";
process.env.DATA_DIR = dir;
process.env.BETTER_AUTH_SECRET = "test-only-secret-not-for-production-at-least-32-chars";
process.env.APP_ORIGIN = "http://127.0.0.1:4318";
process.env.ADMIN_EMAIL = "admin@example.test";
const { api, MAX_CONFIG } = await import("./api");
const { migrate, db, testMailbox } = await import("./auth");
const base = process.env.APP_ORIGIN;
class Client {
  cookies = new Map<string,string>(); bearer = "";
  async request(path: string, body?: unknown, method = "POST", extra: Record<string,string> = {}) {
    const headers: Record<string,string> = { Origin: base, "Content-Type":"application/json", ...extra };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k,v]) => `${k}=${v}`).join("; ");
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    const response = await api(new Request(base + path, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }));
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!, at = pair.indexOf("=");
      this.cookies.set(pair.slice(0,at), pair.slice(at+1));
    }
    return { status:response.status, data:await response.json() };
  }
}
const password = "my-long-test-password-1234";
async function register(email: string) {
  const c = new Client();
  expect((await c.request("/api/auth/sign-up/email", { name:"Tester", email, password })).status).toBe(200);
  expect((await c.request("/api/me", undefined, "GET")).status).toBe(401);
  expect((await c.request("/api/auth/email-otp/send-verification-otp", { email, type:"email-verification" })).status).toBe(200);
  expect((await c.request("/api/auth/email-otp/verify-email", { email, otp:testMailbox.get(email) })).status).toBe(200);
  // Verification must not be equivalent to signing in with two factors.
  expect((await c.request("/api/me", undefined, "GET")).status).toBe(401);
  const login = await c.request("/api/auth/sign-in/email", { email,password });
  expect(login.status).toBe(200); expect(login.data.twoFactorRedirect).toBe(true);
  expect((await c.request("/api/me",undefined,"GET")).status).toBe(401);
  expect((await c.request("/api/auth/two-factor/send-otp", { trustDevice:false })).status).toBe(200);
  const otp = testMailbox.get(email)!;
  expect((await c.request("/api/auth/two-factor/verify-otp", { code:"000000", trustDevice:false })).status).not.toBe(200);
  expect((await c.request("/api/auth/two-factor/verify-otp", { code:otp, trustDevice:false })).status).toBe(200);
  expect((await c.request("/api/me",undefined,"GET")).status).toBe(200);
  return c;
}
beforeAll(migrate);
afterAll(() => { db.close(); rmSync(dir,{recursive:true,force:true}); });
describe("Revolution key system API", () => {
  test("real password + verification + second factor flow and two-user isolation", async () => {
    const first = await register("first@example.test"), second = await register("second@example.test");
    const config = { configVersion:8, modules:{gui:{enabled:true,key:-1,settings:{"Menu scale":0.85}}}, macros:[] };
    expect((await first.request("/api/config",config,"PUT",{"If-Match":"0"})).status).toBe(200);
    expect((await first.request("/api/config",undefined,"GET")).data.config).toEqual(config);
    expect((await second.request("/api/config",undefined,"GET")).data.config).toBeNull();
    expect((await first.request("/api/config",config,"PUT",{"If-Match":"0"})).status).toBe(409);
    expect((await first.request("/api/config", "x".repeat(MAX_CONFIG+1),"PUT",{"If-Match":"1"})).status).toBe(413);
    expect((await first.request("/api/config",{...config,images:["data:image/png;base64,x"]},"PUT",{"If-Match":"1"})).status).toBe(400);
    expect((await first.request("/api/admin/news",{title:"No",body:"No"})).status).toBe(403);
    expect((await first.request("/api/auth/two-factor/disable",{password})).status).toBe(403);
    expect((await first.request("/api/auth/sign-in/email-otp",{email:"first@example.test",otp:"123456"})).status).toBe(403);
    const pairing = await first.request("/api/device/start",{});
    expect(pairing.status).toBe(200);
    const native = new Client();
    expect((await native.request("/api/device/poll",{pollSecret:pairing.data.pollSecret})).status).toBe(202);
    expect((await first.request("/api/device/approve",{code:pairing.data.code})).status).toBe(200);
    const grant = await native.request("/api/device/poll",{pollSecret:pairing.data.pollSecret});
    expect(grant.status).toBe(200); native.bearer=grant.data.accessToken;
    expect((await native.request("/api/config",undefined,"GET")).data.config).toEqual(config);
    expect((await native.request("/api/device/poll",{pollSecret:pairing.data.pollSecret})).status).toBe(410);
    expect((await native.request("/api/admin/news",{title:"No",body:"No"})).status).toBe(403);
    expect((await first.request("/api/device/revoke",{})).status).toBe(200);
    expect((await native.request("/api/config",undefined,"GET")).status).toBe(401);
    const foreign = await api(new Request(base+"/api/config",{method:"PUT",headers:{Origin:"https://attacker.example"},body:"{}"}));
    expect(foreign.status).toBe(403);
    expect((await first.request("/api/auth/sign-out",{})).status).toBe(200);
    expect((await first.request("/api/me",undefined,"GET")).status).toBe(401);
  }, 20000);
  test("only configured verified admin can publish news and a release", async () => {
    const admin = await register("admin@example.test");
    expect((await admin.request("/api/me",undefined,"GET")).data.admin).toBe(true);
    expect((await admin.request("/api/admin/news",{title:"2.1.0",body:"Neuigkeiten"})).status).toBe(200);
    expect((await admin.request("/api/news",undefined,"GET")).data[0].title).toBe("2.1.0");
    expect((await admin.request("/api/admin/releases?version=2.1.0&notes=Test", "PK\u0003\u0004test")).status).toBe(200);
    expect((await admin.request("/api/releases",undefined,"GET")).data[0].version).toBe("2.1.0");
  },20000);
});
