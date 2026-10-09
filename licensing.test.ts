import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A database of its own, built here rather than through `./auth`.
//
// The store is the artifact under test and every function in it takes its database as a parameter, so the test
// can hand it one instead of borrowing the site's - which matters beyond tidiness: `bun test` runs the files in
// one process, and `api.test.ts` closes its database when it is done, so a second file that imported the same
// one failed with "Cannot use a closed database" depending on which file ran first. Owning the file removes the
// question, and it also keeps better-auth and the mailer out of this suite entirely.
const dir = mkdtempSync(join(tmpdir(), "revolution-license-test-"));
process.env.NODE_ENV = "test";
const db = new Database(join(dir, "license.sqlite"), { create: true });
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");

const L = await import("./licensing");
L.installLicensing(db);

const HOUR = 3_600_000;
const DAY = 86_400_000;

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("the key system's rules", () => {
  test("the three plans ship with their own length and price", () => {
    const tiers = L.tiers(db);
    const byId = Object.fromEntries(tiers.map(t => [t.id, t]));
    expect(byId.trial!.days).toBe(1);
    expect(byId.trial!.price).toBe(0);
    expect(byId.monthly!.days).toBe(30);
    expect(byId.yearly!.days).toBe(365);
    expect(byId.monthly!.price).toBeLessThan(byId.yearly!.price);
  });

  test("a price can be changed from the admin side and the order that follows quotes the new one", () => {
    L.setTier(db, "monthly", { price: 7, pay_amount: "7" });
    expect(L.tiers(db).find(t => t.id === "monthly")!.pay_amount).toBe("7");
    const order = L.createOrder(db, { discordId: "buyer-1", ign: "Steve", tierId: "monthly" });
    expect(order.amount).toBe("7");
    L.setTier(db, "monthly", { price: 5, pay_amount: "5" });
  });

  test("an order needs a name, and the name is matched without regard to case", () => {
    expect(() => L.createOrder(db, { discordId: "buyer-2", ign: "not a name", tierId: "monthly" })).toThrow();
    const order = L.createOrder(db, { discordId: "buyer-2", ign: "Alex", tierId: "monthly" });
    const paid = L.recordPayment(db, { ign: "aLEx", amount: 5, raw: "aLeX paid you $5", reporter: "watch-1" });
    expect(paid.matched).toBe(true);
    expect(paid.order!.id).toBe(order.id);
    expect(paid.token!.source).toBe("payment");
    expect(paid.token!.days).toBe(30);
  });

  test("a payment that is the wrong amount, or outside the window, or for a paid order, mints nothing", () => {
    const order = L.createOrder(db, { discordId: "buyer-3", ign: "Robin", tierId: "yearly" });
    // wrong amount: filed, not matched, and the order stays open
    const cheap = L.recordPayment(db, { ign: "Robin", amount: 5, raw: "Robin paid you $5", reporter: "watch-1" });
    expect(cheap.matched).toBe(false);
    expect(L.order(db, order.id)!.status).toBe("open");
    // too late: the window is what makes a payment belong to an order rather than to a name
    const late = L.recordPayment(db, {
      ign: "Robin", amount: 50, raw: "Robin paid you $50", reporter: "watch-1", at: Date.now() + L.PAY_WINDOW_MS + HOUR,
    });
    expect(late.matched).toBe(false);
    // right amount inside the window: this is the one that pays
    const good = L.recordPayment(db, { ign: "Robin", amount: 50, raw: "Robin paid you $50", reporter: "watch-1" });
    expect(good.matched).toBe(true);
    expect(good.token!.days).toBe(365);
    // and a second report of the same payment cannot mint a second code
    const again = L.recordPayment(db, { ign: "Robin", amount: 50, raw: "Robin paid you $50", reporter: "watch-1" });
    expect(again.matched).toBe(false);
    expect(again.token).toBeUndefined();
  });

  test("one buyer's payment never touches another buyer's order", () => {
    const first = L.createOrder(db, { discordId: "buyer-4", ign: "Nina", tierId: "monthly" });
    const second = L.createOrder(db, { discordId: "buyer-5", ign: "Otto", tierId: "monthly" });
    const paid = L.recordPayment(db, { ign: "Otto", amount: 5, raw: "Otto paid you $5", reporter: "watch-1" });
    expect(paid.order!.id).toBe(second.id);
    expect(L.order(db, first.id)!.status).toBe("open");
    expect(L.order(db, second.id)!.status).toBe("paid");
  });

  test("a code is activated once, on one machine, and again on the same machine is not a second activation", () => {
    const code = L.mintForTier(db, "monthly", "admin", "buyer-6");
    expect(code.token).toMatch(/^[0-9A-F]{3}(-[0-9A-F]{3})+$/);
    const first = L.redeem(db, { token: code.token, hwid: "machine-a", ign: "Steve" });
    expect(first.ok).toBe(true);
    // the same machine asking again is a reinstall, not a second activation
    expect(L.redeem(db, { token: code.token, hwid: "machine-a" }).ok).toBe(true);
    // another machine is refused, which is the whole point: one purchase, one client
    const other = L.redeem(db, { token: code.token, hwid: "machine-b" });
    expect(other.ok).toBe(false);
    expect(other.ok === false && other.error).toContain("another client");
    // and the code is not given out twice even with different spacing or case
    expect(L.redeem(db, { token: ` ${code.token.toLowerCase()} `, hwid: "machine-c" }).ok).toBe(false);
    expect(L.redeem(db, { token: "AAA-BBB-CCC", hwid: "machine-a" }).ok).toBe(false);
  });

  test("a licence that has run out is refused, with a reason the panel can show", () => {
    const code = L.mintForTier(db, "trial", "admin", "buyer-7");
    expect(L.redeem(db, { token: code.token, hwid: "machine-d", ign: "Steve" }).ok).toBe(true);
    expect(L.session(db, { hwid: "machine-d" }).active).toBe(true);
    // moving the clock rather than waiting for it: the row is what the decision is made from
    db.query("UPDATE lic_sessions SET expires=? WHERE hwid=?").run(Date.now() - HOUR, L.hashHwid("machine-d"));
    const after = L.session(db, { hwid: "machine-d" });
    expect(after.active).toBe(false);
    expect(after.reason).toContain("run out");
  });

  test("a code nobody used is deleted when its window closes, and one that was revoked stops a session", () => {
    const unused = L.mintForTier(db, "monthly", "trial", "buyer-8");
    db.query("UPDATE lic_tokens SET redeem_by=? WHERE token=?").run(Date.now() - HOUR, unused.token);
    const swept = L.purge(db);
    expect(swept.tokens).toBeGreaterThan(0);
    expect(L.findToken(db, unused.token)).toBeNull();
    // Log lines that have been posted are history, not state: the housekeeping sweeps the old ones, and it has
    // to leave the unposted ones alone - sweeping those would be a payment announced to nobody.
    L.queueEvent(db, "paid", "an old line that was delivered", null);
    const oldId = (db.query("SELECT MAX(id) AS id FROM lic_events").get() as { id: number }).id;
    L.markPosted(db, oldId);
    db.query("UPDATE lic_events SET at=? WHERE id=?").run(Date.now() - 40 * 86_400_000, oldId);
    L.queueEvent(db, "paid", "a line nobody has seen yet", "buyer-x");
    const sweptAgain = L.purge(db);
    expect(sweptAgain.events).toBe(1);
    const kept = db.query("SELECT COUNT(*) AS n FROM lic_events WHERE id=?").get(oldId) as { n: number };
    expect(kept.n).toBe(0);
    expect(L.unpostedEvents(db).some(e => e.text === "a line nobody has seen yet")).toBe(true);
    // revocation: the code stops working and the session that used it is gone
    const live = L.mintForTier(db, "monthly", "payment", "buyer-9");
    expect(L.redeem(db, { token: live.token, hwid: "machine-e" }).ok).toBe(true);
    L.revokeToken(db, live.token);
    expect(L.session(db, { hwid: "machine-e" }).active).toBe(false);
    expect(L.redeem(db, { token: live.token, hwid: "machine-e" }).ok).toBe(false);
  });

  test("checking in reports the licence, the name and how many payments came in", () => {
    const code = L.mintForTier(db, "monthly", "admin", "buyer-10");
    L.redeem(db, { token: code.token, hwid: "machine-f", ign: "Robin" });
    const one = L.session(db, { hwid: "machine-f", ign: "Robin", countReport: true });
    expect(one.active).toBe(true);
    expect(one.tier).toBe("monthly");
    expect(one.payments).toBeGreaterThanOrEqual(2); // the yearly and monthly payments made above are Robin's
    L.session(db, { hwid: "machine-f", ign: "Robin", countReport: true });
    const reports = db.query("SELECT reports FROM lic_sessions WHERE hwid=?").get(L.hashHwid("machine-f")) as { reports: number };
    expect(reports.reports).toBe(2);
    // a client with no code is told why instead of being told nothing
    const none = L.session(db, { hwid: "machine-zz" });
    expect(none.active).toBe(false);
    expect(none.reason).toBeTruthy();
  });

  test("a session is logged in as what it plays as, and the raw client id is never stored", () => {
    expect(L.hashHwid("machine-f")).not.toContain("machine-f");
    expect(L.hashHwid("machine-f")).toBe(L.hashHwid("machine-f"));
    expect(L.normaliseIgn("  Steve_  ")).toBe("steve_");
  });

  test("a licence running out is announced once, not once per sweep", () => {
    const code = L.mintForTier(db, "monthly", "admin", "buyer-11");
    L.redeem(db, { token: code.token, hwid: "machine-g" });
    db.query("UPDATE lic_tokens SET license_expires=? WHERE token=?").run(Date.now() + DAY, code.token);
    L.purge(db);
    L.purge(db);
    const announced = db.query("SELECT COUNT(*) AS n FROM lic_events WHERE kind='expiring' AND text LIKE ?")
      .get(`%${code.token}%`) as { n: number };
    expect(announced.n).toBe(1);
  });

  test("the payment line is one template, so a change of account is not a change of code", () => {
    const previous = process.env.LICENSE_PAY_COMMAND;
    expect(L.payCommand("5", "Steve")).toBe("/pay 5 Steve");
    process.env.LICENSE_PAY_COMMAND = "/pay {ign} {amount}";
    expect(L.payCommand("5", "Steve")).toBe("/pay Steve 5");
    if (previous === undefined) delete process.env.LICENSE_PAY_COMMAND;
    else process.env.LICENSE_PAY_COMMAND = previous;
  });

  test("no two codes collide, and the panel's numbers come out of the same store", () => {
    const entropy = L.codeEntropy();
    expect(entropy.unique).toBe(200);
    const summary = L.stats(db);
    expect(summary.paid).toBeGreaterThan(0);
    expect(summary.active).toBeGreaterThan(0);
    expect(summary.unmatched).toBeGreaterThan(0);
    expect(L.openOrders(db).every(o => o.status === "open")).toBe(true);
  });

  test("what happens is queued for the bot, and the bot's reader is paged", () => {
    const first = L.unpostedEvents(db);
    expect(first.length).toBeGreaterThan(0);
    expect(first.some(e => e.kind === "paid")).toBe(true);
    // The reader is bounded, and that is deliberate: the outbox is a queue the bot drains on a timer, not a
    // table it loads. So the page never exceeds what was asked for - and the way to empty it is to keep
    // reading and marking, which is exactly what the bot's own loop does.
    expect(L.unpostedEvents(db, 5).length).toBeLessThanOrEqual(5);
    let drained = 0;
    for (let guard = 0; guard < 100; guard++) {
      const page = L.unpostedEvents(db);
      if (!page.length) break;
      for (const event of page) L.markPosted(db, event.id);
      drained += page.length;
    }
    expect(drained).toBeGreaterThanOrEqual(first.length);
    expect(L.unpostedEvents(db).length).toBe(0);
  });
});
