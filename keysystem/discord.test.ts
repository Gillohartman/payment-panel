import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionFlagsBits, type Interaction } from "discord.js";
import * as R from "./discord-rules";
// Type-only, so it is erased: `./bot` is imported below as a value, after the environment it reads at import time
// has been set, and an ordinary import here would load it before that.
import type { Delivery } from "./bot";

/**
 * The Discord side, tested where it can be.
 *
 * What is here is the half of the bot that decides something: the trial gate, the private-channel rule, the
 * price check, and - the one that used to be a hole - the path a bought code takes from the store to the DM that
 * carries it. A live connection is not needed for any of it and cannot be had in this environment, so the
 * alternative to this file is no test at all.
 *
 * The test that earns its keep is `every button the panel builds is answered by a handler`. A panel button and
 * the handler that answers it are two string literals 400 lines apart in `bot.ts`, and a typo between them is a
 * dead button on a live server: it compiles, it registers, it renders, and pressing it does nothing. Both sides
 * now come from the same constants, and this walks every id the panel can produce through the handler's own
 * predicate.
 */
const dir = mkdtempSync(join(tmpdir(), "revolution-discord-test-"));
const db = new Database(join(dir, "discord.sqlite"), { create: true });
const L = await import("./licensing");
L.installLicensing(db);

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

// The bot is imported last, after the environment it reads at import time has been set: the admin ids are read
// once when the module loads, and its own database handle is created by ./auth. None of that touches the database
// the handlers work on, because `useDatabase` points them at this file's own - which is what keeps this file
// independent of api.test.ts, whose `afterAll` closes the site's database.
process.env.ADMIN_DISCORD_IDS = "admin-1";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "revolution-bot-import-"));
process.env.BETTER_AUTH_SECRET = "test-only-secret-not-for-production-at-least-32-chars";
process.env.APP_ORIGIN = "http://127.0.0.1:4318";
delete process.env.TRIAL_ROLE_ID;
const bot = await import("./bot");
bot.useDatabase(db);

const dayMs = 86_400_000;
const plans = (): R.PlanView[] => L.tiers(db).map(t => ({ ...t }));

type Capture = { replies: any[]; modals: any[]; dms: any[]; created: any[]; sent: any[] };
/** An interaction that was created long enough ago to pass the trial gate. */
const old = () => Date.now() - 400 * dayMs;
const json = (value: unknown) => JSON.stringify(value);

/**
 * A fake interaction: it records what the handlers did to it.
 *
 * Shared by every suite below, because all of them drive the same real handlers - the buyer's walk, the routing
 * table and the admin paths differ in which overrides they pass, not in the fake they pass them to.
 */
function fake(overrides: Record<string, unknown> = {}) {
  const capture: Capture = { replies: [], modals: [], dms: [], created: [], sent: [] };
  const base: Record<string, unknown> = {
    reply: async (payload: unknown) => { capture.replies.push(payload); },
    showModal: async (modal: unknown) => { capture.modals.push(modal); },
    user: { id: "buyer-1", username: "Buyer One", createdTimestamp: old(), send: async (message: unknown) => { capture.dms.push(message); } },
    member: null, guildId: null, guild: null, channel: null, channelId: "ticket-1", customId: "", values: [],
    // The application the interaction belongs to - where the ticket takes the bot's own id from.
    client: { user: { id: "bot-1" } },
    isButton: () => false, isModalSubmit: () => false, isChatInputCommand: () => false, isStringSelectMenu: () => false,
    options: { getSubcommand: () => "", getString: () => null, getInteger: () => null },
    fields: { getTextInputValue: () => "" },
    ...overrides,
  };
  return { interaction: base as unknown as Interaction, capture };
}

/** The admin interactions all name the same admin, which `ADMIN_DISCORD_IDS` put on the list above. */
const adminUser = () => ({ id: "admin-1", username: "admin-1", createdTimestamp: old(), send: async () => undefined });

describe("the bot's decisions", () => {
  test("a name, a payment line and a username cannot break out of a message", () => {
    // @everyone must stop being a mention, a backtick must stop closing the code block a code is drawn in, and
    // a wall of text must stay a wall of text rather than becoming the message.
    expect(R.esc("@everyone")).not.toContain("@everyone");
    expect(R.esc("`code`")).toContain("\\`");
    expect(R.esc("Ben *the* _bold_")).toContain("\\*");
    expect(R.esc("x".repeat(5000)).length).toBeLessThanOrEqual(300);
    expect(R.esc("Steve_123")).toContain("Steve");
  });

  test("a ticket name is always a channel name Discord will accept", () => {
    expect(R.slug("Steve_123")).toBe("steve-123");
    expect(R.slug("...")).toBe("buyer");
    expect(R.slug("    ")).toBe("buyer");
    expect(R.slug("a".repeat(200)).length).toBeLessThanOrEqual(24);
    expect(R.ticketName("monthly", "A Very Odd Name!")).toMatch(/^buy-monthly-[a-z0-9-]+$/);
  });

  test("the trial gate is a role when there is one, and an account age when there is not", () => {
    const fresh = Date.now();
    const old = fresh - 30 * dayMs;
    const young = fresh - dayMs;
    // the role is the thing you control, so it is the whole answer when it is configured
    expect(R.trialAllowed({ accountCreatedAt: young, hasTrialRole: true, minAgeDays: 7, at: fresh })).toBe(true);
    expect(R.trialAllowed({ accountCreatedAt: old, hasTrialRole: false, minAgeDays: 7, at: fresh })).toBe(true);
    expect(R.trialAllowed({ accountCreatedAt: young, hasTrialRole: false, minAgeDays: 7, at: fresh })).toBe(false);
    // the boundary is inclusive: an account exactly at the limit is allowed rather than refused by a millisecond
    expect(R.trialAllowed({ accountCreatedAt: fresh - 7 * dayMs, hasTrialRole: false, minAgeDays: 7, at: fresh })).toBe(true);
    expect(R.trialAllowed({ accountCreatedAt: fresh - 7 * dayMs + 1, hasTrialRole: false, minAgeDays: 7, at: fresh })).toBe(false);
  });

  test("the admin panel is only usable where other people cannot read it", () => {
    // a DM is private by definition
    expect(R.privateEnough({ guildId: null, everyoneCanView: null, anywhere: false })).toBe(true);
    // a channel @everyone cannot view is private
    expect(R.privateEnough({ guildId: "g", everyoneCanView: false, anywhere: false })).toBe(true);
    // a channel everybody can read is not
    expect(R.privateEnough({ guildId: "g", everyoneCanView: true, anywhere: false })).toBe(false);
    // and a permission that could not be read is treated as not private rather than as private
    expect(R.privateEnough({ guildId: "g", everyoneCanView: null, anywhere: false })).toBe(false);
    expect(R.privateEnough({ guildId: "g", everyoneCanView: true, anywhere: true })).toBe(true);
  });

  test("a price is a number and a length, or it is refused", () => {
    expect(R.checkPrice("5", 30)).toEqual({ ok: true, amount: "5", days: 30 });
    expect(R.checkPrice(" 7.50 ", "365")).toEqual({ ok: true, amount: "7.50", days: 365 });
    for (const bad of [["5", 0], ["5", 3651], ["5", 1.5], ["", 30], ["five", 30], ["-5", 30], ["0", 30], ["5.555", 30], ["1e3", 30]]) {
      expect(R.checkPrice(String(bad[0]), bad[1] as number).ok).toBe(false);
    }
  });

  test("every button the panel builds is answered by a handler", () => {
    const panel = R.panelButtons(plans());
    expect(panel.length).toBeGreaterThanOrEqual(2);
    expect(panel[0]!.id).toBe(R.ID.panelTrial);
    for (const button of panel) {
      expect(R.answers.panel(button.id), `nothing answers ${button.id}`).toBe(true);
      // and it must not be answered by the wrong handler as well
      expect(R.answers.admin(button.id)).toBe(false);
      expect(R.answers.ticket(button.id)).toBe(false);
    }
    const admin = R.adminButtons();
    for (const button of admin) expect(R.answers.admin(button.id), `nothing answers ${button.id}`).toBe(true);
    expect(R.answers.ticket(`${R.ID.ticketForm}monthly`)).toBe(true);
    expect(R.answers.order(`${R.ID.orderCancel}order-id`)).toBe(true);
    expect(R.tierFromId(`${R.ID.panelTier}yearly`)).toBe("yearly");
    expect(R.tierFromId(`${R.ID.ticketForm}monthly`)).toBe("monthly");
    expect(R.tierFromId("admin:gen")).toBeNull();
    // the plan ids in the buttons are the store's own, so a renamed plan cannot leave a button pointing nowhere
    for (const button of panel.filter(b => b.id !== R.ID.panelTrial)) {
      const id = R.tierFromId(button.id);
      expect(plans().some(p => p.id === id)).toBe(true);
    }
  });

  test("a bought code reaches the buyer's DM as the same code the store minted", () => {
    // This is the whole chain in one test: a ticket's order, a payment detected in game, the code the store
    // writes, and the string the bot would put in a DM. It used to be recovered by splitting the event's
    // sentence on "code ", which is a link that breaks silently when the sentence changes.
    const order = L.createOrder(db, { discordId: "buyer-dm", ign: "Steve", tierId: "monthly" });
    const paid = L.recordPayment(db, { ign: "Steve", amount: Number(order.amount), raw: "Steve paid you $5", reporter: "watch-1" });
    expect(paid.matched).toBe(true);
    const event = L.unpostedEvents(db).filter(e => e.kind === "paid").at(-1)!;
    expect(event.discord_id).toBe("buyer-dm");
    const fromStore = R.codeFromEvent(event);
    expect(fromStore).toBe(paid.token!.token);
    // and the code that reaches the DM is the code that activates the client
    expect(L.redeem(db, { token: fromStore!, hwid: "dm-machine" }).ok).toBe(true);
    // an event queued by a build without the column still yields its code
    expect(R.codeFromEvent({ kind: "paid", text: "Steve paid 5 - code ABC-DEF-123" })).toBe("ABC-DEF-123");
    expect(R.codeFromEvent({ kind: "paid", text: "no marker here" })).toBeNull();
    expect(R.codeFromEvent({ kind: "minted", text: "code ABC-DEF-123", code: "ABC-DEF-123" })).toBeNull();
  });

  test("the log channel is a setting, so moving it survives a restart", () => {
    // What bot.ts's logChannel() does: the admin's choice first, then the environment, then nowhere.
    expect(L.getSetting(db, "log_channel", "env-channel")).toBe("env-channel");
    L.setSetting(db, "log_channel", "123456789");
    expect(L.getSetting(db, "log_channel", "env-channel")).toBe("123456789");
    L.setSetting(db, "log_channel", "987654321");
    expect(L.getSetting(db, "log_channel", "env-channel")).toBe("987654321");
    // and it is queued like everything else, so the bot can post what happened while nobody was watching
    L.queueEvent(db, "paid", "Steve paid 5 for monthly", "buyer-dm");
    expect(L.unpostedEvents(db).length).toBeGreaterThan(0);
  });
});

/**
 * The outbox, driven end to end.
 *
 * This is the last link in the chain that matters - a payment is detected, a code is minted, and something has
 * to put that code in front of the buyer - and it was the one link with no test at all, because the only way in
 * was a live gateway. `deliver` now takes a pair of calls instead of reaching for the client, so the whole chain
 * can be walked: a real order, a real payment, a real code out of the store, and the exact string that would
 * arrive in the buyer's DMs.
 *
 * The failure this suite is really about is the quiet one. A code that is minted and never delivered is a buyer
 * who paid and got nothing, and a queue that stops on the first closed inbox stops for everybody behind it.
 */
describe("the outbox", () => {
  function delivery(overrides: Partial<Delivery> = {}) {
    const dms: { id: string; content: string }[] = [];
    const lines: { channel: string; content: string }[] = [];
    const link: Delivery = {
      dm: async (id, content) => { dms.push({ id, content }); return true; },
      logLine: async (channel, content) => { lines.push({ channel, content }); return true; },
      ...overrides,
    };
    return { link, dms, lines };
  }

  /** What the suites above queued is not this suite's business: deliver it with a throwaway recorder. */
  async function drain() {
    await bot.deliver(delivery().link);
  }

  test("a detected payment becomes one DM carrying exactly the code the store minted", async () => {
    await drain();
    L.setSetting(db, "log_channel", "log-1");
    const order = L.createOrder(db, { discordId: "buyer-outbox", ign: "Alex", tierId: "monthly" });
    const paid = L.recordPayment(db, { ign: "alex", amount: Number(order.amount), raw: `Alex paid you ${order.amount}`, reporter: "watch-1" });
    expect(paid.matched).toBe(true);
    expect(paid.token).toBeTruthy();

    const out = delivery();
    await bot.deliver(out.link);

    expect(out.dms).toHaveLength(1);
    expect(out.dms[0]!.id).toBe("buyer-outbox");
    expect(out.dms[0]!.content).toContain(paid.token!.token);
    // the string the buyer was sent is a code that activates a client, not just text that looks like one
    expect(L.redeem(db, { token: paid.token!.token, hwid: "outbox-machine" }).ok).toBe(true);
    // the admin's channel got its lines - the payment, and the mint behind it - so a delivery that never
    // arrived is still visible there
    const lines = out.lines.filter(l => l.channel === "log-1");
    expect(lines).toHaveLength(2);
    expect(lines.some(l => l.content.includes("paid"))).toBe(true);
    // and the queue is drained of the payment, so the five-second interval does not send the same code again.
    // The question is asked of paid events rather than of the whole queue because redeeming, two lines up,
    // queued an activation of its own - which is not a payment and is not sent anywhere as a DM.
    expect(L.unpostedEvents(db).filter(e => e.kind === "paid")).toHaveLength(0);
    await bot.deliver(out.link);
    expect(out.dms).toHaveLength(1);
  });

  test("a DM that cannot be delivered is logged, and does not hold the queue behind it", async () => {
    await drain();
    L.setSetting(db, "log_channel", "log-2");
    const order = L.createOrder(db, { discordId: "closed-inbox", ign: "Blake", tierId: "monthly" });
    L.recordPayment(db, { ign: "Blake", amount: Number(order.amount), raw: "Blake paid you 5", reporter: "watch-1" });

    const attempts: { id: string; content: string }[] = [];
    const out = delivery({ dm: async (id, content) => { attempts.push({ id, content }); return false; } });
    await bot.deliver(out.link);

    // it was tried, and the buyer's own code was what was in the message
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.id).toBe("closed-inbox");
    // the recovery path: the payment's own log line names the buyer and carries the code, so an admin can still
    // hand it over. The `minted` line queued alongside it is the one without a code, so this reads the paid one.
    const lines = out.lines.filter(l => l.channel === "log-2");
    const paidLine = lines.find(l => l.content.includes("paid"));
    expect(paidLine).toBeTruthy();
    const code = /([0-9A-F]{3}(?:-[0-9A-F]{3})+)/.exec(paidLine!.content)?.[1] ?? "";
    expect(L.findToken(db, code)?.discord_id).toBe("closed-inbox");
    // and an undeliverable DM is not retried forever - a queue that never empties is a queue nothing gets past
    expect(L.unpostedEvents(db)).toHaveLength(0);
  });

  test("only a payment is DMed, and one whose code cannot be read still tells the buyer something", async () => {
    await drain();
    L.setSetting(db, "log_channel", "log-3");
    // A paid event queued by a build without the code column, so there is a buyer to tell and nothing to hand over.
    L.queueEvent(db, "paid", "Blake paid 5 for monthly", "old-build-buyer");
    // An activation names somebody too - a code to a DM nobody needs, and one that is already spent anyway.
    L.queueEvent(db, "activated", "Code ABC-DEF-123 activated monthly", "old-build-buyer");

    const out = delivery();
    await bot.deliver(out.link);

    expect(out.dms).toHaveLength(1);
    expect(out.dms[0]!.content).toContain("admin");
    // both events reached the log channel; only the payment reached a DM
    expect(out.lines.filter(l => l.channel === "log-3")).toHaveLength(2);
  });
});

/**
 * The routing table, as a thing that can be wrong.
 *
 * `dispatch` is the one function the gateway calls, and the order inside it is a decision: a price modal shares
 * the `admin:price` prefix with the button that opens it, so the modal has to be asked first, and a modal that
 * fell through to the button handler would be answered with a message no user can see. Driving the real
 * handlers through this one entry point is the closest thing to pressing the buttons in a live server.
 */
describe("the routing", () => {
  test("each kind of interaction reaches the handler that owns it", async () => {
    // The plan this suite changes is put back afterwards: what a plan costs is decided by the admin suites, and
    // a test that left the store altered would make the next one fail for a reason of its own.
    const plan = { ...L.tiers(db).find(t => t.id === "yearly")! };
    const modal = fake({
      isModalSubmit: () => true, customId: `${R.ID.adminPrice}:yearly`, user: adminUser(),
      fields: { getTextInputValue: (name: string) => (name === "amount" ? "12" : "60") },
    });
    await bot.dispatch(modal.interaction);
    expect(L.tiers(db).find(t => t.id === "yearly")).toMatchObject({ pay_amount: "12", days: 60 });
    expect(String(modal.capture.replies[0].content)).toContain("12");
    L.setTier(db, "yearly", { pay_amount: plan.pay_amount, days: plan.days });
    expect(L.tiers(db).find(t => t.id === "yearly")).toMatchObject({ pay_amount: plan.pay_amount, days: plan.days });

    // A button, on an account of its own because the free day is one per account (see the walk above).
    const button = fake({
      isButton: () => true, customId: R.ID.panelTrial,
      user: { id: "router-buyer", username: "router-buyer", createdTimestamp: old(), send: async () => undefined },
    });
    await bot.dispatch(button.interaction);
    expect(String(button.capture.replies[0].content)).toContain("Activate it in the client");

    // A select menu: the admin's plan choice, answered by the select handler with the price modal.
    const select = fake({ isStringSelectMenu: () => true, customId: R.ID.adminPriceTier, values: ["monthly"], user: adminUser() });
    await bot.dispatch(select.interaction);
    expect(select.capture.modals).toHaveLength(1);

    // A name modal, which is the last resort because it is the only remaining kind of modal.
    const name = fake({
      isModalSubmit: () => true, customId: `${R.ID.orderIgn}monthly`,
      fields: { getTextInputValue: (n: string) => (n === "ign" ? "Rita" : "") },
    });
    await bot.dispatch(name.interaction);
    expect(L.openOrders(db).some(o => o.ign === "Rita")).toBe(true);

    // And an interaction the bot has no business answering is answered with nothing at all.
    const ignored = fake({});
    await bot.dispatch(ignored.interaction);
    expect(ignored.capture.replies).toHaveLength(0);
    expect(ignored.capture.modals).toHaveLength(0);
  });
});

/**
 * The whole walk a buyer takes, driven through the bot's own handlers.
 *
 * The handlers are the real ones - the same functions the gateway calls - and only Discord is faked: a stub that
 * records what was replied, what was DMed, which channel was created and what went into it. That is as close as
 * this environment can get to pressing a button, and it is much closer than reading the file: it checks what the
 * *store* looks like afterwards, so a handler that answers cheerfully while writing nothing fails.
 */
describe("the buyer's walk", () => {
  test("the trial button hands out a code that actually activates a client", async () => {
    const { interaction, capture } = fake({ isButton: () => true, customId: R.ID.panelTrial });
    expect(await bot.handleButton(interaction)).toBeUndefined();
    expect(capture.replies).toHaveLength(1);
    const content = String(capture.replies[0].content);
    const code = /([0-9A-F]{3}(?:-[0-9A-F]{3})+)/.exec(content)?.[1] ?? "";
    expect(code).not.toBe("");
    // the point of the test: the string the buyer was shown is a working code, not just a string
    expect(L.redeem(db, { token: code, hwid: "trial-machine" }).ok).toBe(true);
    const token = L.findToken(db, code)!;
    expect(token.source).toBe("trial");
    expect(token.days).toBe(1);
    // and it went to their DMs too, so closing the message does not lose it
    expect(capture.dms).toHaveLength(1);
    expect(json(capture.dms[0])).toContain(code);
  });

  test("a brand new account is refused the free day, and told why", async () => {
    const { interaction, capture } = fake({
      isButton: () => true, customId: R.ID.panelTrial,
      user: { id: "newbie-1", username: "newbie-1", createdTimestamp: Date.now(), send: async () => undefined },
    });
    await bot.handleButton(interaction);
    expect(String(capture.replies[0].content)).toContain("established");
    // and nothing was minted for it
    expect(db.query("SELECT COUNT(*) AS n FROM lic_tokens WHERE source='trial' AND discord_id=?").get("newbie-1")).toEqual({ n: 0 });
  });

  test("a plan button opens a private ticket and asks for the name inside it", async () => {
    const ticket = { id: "ticket-9", send: async (payload: unknown) => { capture.sent.push(payload); } };
    const capture = { sent: [] as any[] };
    const created: any[] = [];
    const guild = {
      id: "guild-1", roles: { everyone: { id: "everyone-role" } },
      channels: { create: async (options: unknown) => { created.push(options); return ticket; } },
    };
    const { interaction, capture: replies } = fake({ isButton: () => true, customId: `${R.ID.panelTier}monthly`, guild, guildId: "guild-1" });
    await bot.handleButton(interaction);

    expect(created).toHaveLength(1);
    const options = created[0];
    // Privacy is the thing to check here: a ticket everyone can read is a payment line everyone can read.
    const overwrites = options.permissionOverwrites as { id: string; deny?: bigint[]; allow?: bigint[] }[];
    expect(overwrites.find(o => o.id === "everyone-role")?.deny).toContain(PermissionFlagsBits.ViewChannel);
    expect(overwrites.find(o => o.id === "buyer-1")?.allow).toContain(PermissionFlagsBits.ViewChannel);
    expect(overwrites.find(o => o.id === "bot-1")?.allow).toContain(PermissionFlagsBits.SendMessages);
    // The form button lives in the ticket, and the id it carries is one the handler answers.
    expect(json(capture.sent[0])).toContain(R.ID.ticketForm);
    expect(R.answers.ticket(JSON.parse(json(capture.sent[0])).components[0].components[0].custom_id)).toBe(true);
    // The public reply only points at the ticket; it carries no name and no payment line.
    expect(String(replies.replies[0].content)).toContain("ticket-9");
  });

  test("the name modal makes an order, quotes the right line, and the cancel button cancels it", async () => {
    const submitted = fake({
      isModalSubmit: () => true, customId: `${R.ID.orderIgn}monthly`,
      fields: { getTextInputValue: (name: string) => (name === "ign" ? "Steve" : "") },
    });
    await bot.handleOrderModal(submitted.interaction);
    const amount = L.tiers(db).find(t => t.id === "monthly")!.pay_amount;
    expect(json(submitted.capture.replies[0])).toContain(`/pay ${amount} Steve`);

    const order = L.openOrders(db).find(o => o.ign === "Steve");
    expect(order).toBeTruthy();
    expect(order!.amount).toBe(amount);
    expect(order!.discord_id).toBe("buyer-1");

    const cancelId = `${R.ID.orderCancel}${order!.id}`;
    expect(json(submitted.capture.replies[0])).toContain(cancelId);
    const cancelled = fake({ isButton: () => true, customId: cancelId });
    await bot.handleButton(cancelled.interaction);
    expect(L.order(db, order!.id)!.status).toBe("cancelled");
    // and a stranger cannot cancel somebody else's order
    const other = L.createOrder(db, { discordId: "buyer-2", ign: "Otto", tierId: "monthly" });
    const stranger = fake({ isButton: () => true, customId: `${R.ID.orderCancel}${other.id}`, user: { id: "stranger", username: "stranger", createdTimestamp: old(), send: async () => undefined } });
    await bot.handleButton(stranger.interaction);
    expect(L.order(db, other.id)!.status).toBe("open");
  });

  test("an admin changes a price with a command, and a stranger cannot", async () => {
    const { interaction, capture } = fake({
      isChatInputCommand: () => true, commandName: "admin",
      options: { getSubcommand: () => "price", getString: (n: string) => (n === "plan" ? "monthly" : "9"), getInteger: () => 45 },
      user: { id: "admin-1", username: "admin-1", createdTimestamp: old(), send: async () => undefined },
    });
    await bot.handleCommand(interaction);
    const tier = L.tiers(db).find(t => t.id === "monthly")!;
    expect(tier.pay_amount).toBe("9");
    expect(tier.days).toBe(45);
    expect(String(capture.replies[0].content)).toContain("9");
    // the command and the modal validate the same way, so a bad number is refused rather than stored
    const bad = fake({
      isChatInputCommand: () => true, commandName: "admin",
      options: { getSubcommand: () => "price", getString: (n: string) => (n === "plan" ? "monthly" : "five"), getInteger: () => 45 },
      user: { id: "admin-1", username: "admin-1", createdTimestamp: old(), send: async () => undefined },
    });
    await bot.handleCommand(bad.interaction);
    expect(String(bad.capture.replies[0].content)).toContain("number");
    expect(L.tiers(db).find(t => t.id === "monthly")!.pay_amount).toBe("9");

    const stranger = fake({
      isChatInputCommand: () => true, commandName: "admin",
      options: { getSubcommand: () => "stats", getString: () => null, getInteger: () => null },
      user: { id: "nobody", username: "nobody", createdTimestamp: old(), send: async () => undefined },
    });
    await bot.handleCommand(stranger.interaction);
    expect(String(stranger.capture.replies[0].content)).toContain("Not for you");
  });

  test("the free day is one per account, and pressing it again does not mint another", async () => {
    // The panel's own words are "1 day, once per account". The account-age gate cannot carry that rule - an
    // account only gets older - so the store has to, and this drives it the way the buyer does.
    const fresh = (id: string) => ({ id, username: id, createdTimestamp: old(), send: async () => undefined });
    const first = fake({ isButton: () => true, customId: R.ID.panelTrial, user: fresh("trial-once") });
    await bot.handleButton(first.interaction);
    const minted = /([0-9A-F]{3}(?:-[0-9A-F]{3})+)/.exec(String(first.capture.replies[0].content))?.[1] ?? "";
    expect(minted).not.toBe("");

    const again = fake({ isButton: () => true, customId: R.ID.panelTrial, user: fresh("trial-once") });
    await bot.handleButton(again.interaction);
    expect(String(again.capture.replies[0].content)).toContain("already had");
    // nothing was minted for the second press, which is the part that would otherwise be a free licence
    expect(db.query("SELECT COUNT(*) AS n FROM lic_tokens WHERE source='trial' AND discord_id=?").get("trial-once")).toEqual({ n: 1 });
    // and it is per account: somebody else pressing it in the same minute still gets theirs
    const other = fake({ isButton: () => true, customId: R.ID.panelTrial, user: fresh("trial-other") });
    await bot.handleButton(other.interaction);
    expect(String(other.capture.replies[0].content)).toContain("Activate it in the client");
  });

  test("an admin mints a code with no payment, and the panel is the same buttons", async () => {
    const { interaction, capture } = fake({
      isChatInputCommand: () => true, commandName: "admin",
      options: { getSubcommand: () => "code", getString: () => "yearly", getInteger: () => null },
      user: { id: "admin-1", username: "admin-1", createdTimestamp: old(), send: async () => undefined },
    });
    await bot.handleCommand(interaction);
    const code = /([0-9A-F]{3}(?:-[0-9A-F]{3})+)/.exec(String(capture.replies[0].content))?.[1] ?? "";
    expect(code).not.toBe("");
    expect(L.findToken(db, code)!.source).toBe("admin");
    expect(L.findToken(db, code)!.days).toBe(365);

    const panel = fake({
      isChatInputCommand: () => true, commandName: "admin",
      options: { getSubcommand: () => "panel", getString: () => null, getInteger: () => null },
      user: { id: "admin-1", username: "admin-1", createdTimestamp: old(), send: async () => undefined },
    });
    await bot.handleCommand(panel.interaction);
    for (const button of R.adminButtons()) expect(json(panel.capture.replies[0])).toContain(button.id);
  });
});
