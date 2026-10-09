/**
 * Everything the Discord bot decides, with Discord taken out of it.
 *
 * `bot.ts` is the connection: gateways, channels, replies, modals. This file is the part that can be wrong in a
 * way nobody notices until somebody presses a button - which gates the free trial, whether a channel is private
 * enough for the admin panel, what a button's id has to be for its handler to answer it, and how a code is
 * recovered from a queued event. None of it touches a Discord object, so all of it is driven by
 * `discord.test.ts` without a token, a server or a network.
 *
 * The button ids are the clearest example of why this is separate. A panel button and the handler that answers
 * it are two string literals in two places, and a typo between them is a dead button on a live server - the one
 * kind of bug this project cannot see from a compiler or from a test of the rules. Both halves are built from
 * the same constants here, and a test walks every id the panel produces and asks the handler's own predicate
 * whether it would answer it.
 */

/** A plan as the panel shows it: the id is what the button carries and what the store is keyed on. */
export type PlanView = { id: string; label: string; days: number; price: number; pay_amount: string };

/** One button, before it becomes a Discord component. */
export type ButtonSpec = { id: string; label: string; style: "success" | "primary" | "secondary" | "danger" };

/** The prefixes. One list, read by the builders and by the predicates below. */
export const ID = {
  panelTrial: "panel:trial",
  panelTier: "panel:tier:",
  ticketForm: "ticket:form:",
  orderIgn: "order:ign:",
  orderCancel: "order:cancel:",
  adminGen: "admin:gen",
  adminGenTier: "admin:gentier",
  adminPrice: "admin:price",
  adminPriceTier: "admin:pricetier",
  adminOrders: "admin:orders",
  adminLog: "admin:log",
  adminStats: "admin:stats",
} as const;

/**
 * Anything a person typed, made safe to put in a message.
 *
 * A Minecraft name, a payment line and a ticket name are all user input. Without this, a name containing
 * `@everyone` mentions the channel, and one containing a backtick closes the code block the code is drawn in -
 * which, for a message whose whole content is a code, is the difference between showing it and mangling it. The
 * `@` gets a zero-width space rather than a backslash so it still reads as a name to a human.
 */
export const esc = (value: string) => value.replace(/@/g, "@\u200B").replace(/([\\`*_~|>])/g, "\\$1").slice(0, 300);

/**
 * A channel name Discord will accept, from a username that may contain anything.
 *
 * Total on purpose: a username always exists when Discord hands one over, but a helper that throws on an absent
 * one turns a missing field into an interaction that never answers, and this is called inside the one step of the
 * flow where a thrown error means a buyer gets no ticket at all.
 */
export const slug = (value: string) =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "buyer";

/** The ticket a plan opens: it says what is being bought and who is buying it, and nothing else. */
export const ticketName = (tierId: string, username: string) => `buy-${slug(tierId)}-${slug(username)}`;

/**
 * Whether the free day may be handed out.
 *
 * Discord does not give bots an email-verification flag, so "only verified accounts" cannot be asked. The two
 * things that *can* be asked are an account old enough not to be a throwaway and a role you hand out yourself -
 * and when the role is configured it replaces the age rule rather than adding to it, because a role is the thing
 * you actually control. This is written as the decision rather than as an approximation so the message the
 * person gets can say which one they missed.
 */
export function trialAllowed(input: { accountCreatedAt: number; hasTrialRole: boolean; minAgeDays: number; at?: number }) {
  const at = input.at ?? Date.now();
  if (input.hasTrialRole) return true;
  return at - input.accountCreatedAt >= input.minAgeDays * 86_400_000;
}

/**
 * Whether this channel is private enough for the admin panel.
 *
 * The rule is "private places only", and Discord has no flag for it - what it has is what @everyone may do.
 * A channel @everyone cannot view is private; a DM has no guild and is private by definition; anything else is
 * not, unless the escape hatch is set. `everyoneCanView` is null when the permission could not be read, and the
 * safe reading of "I do not know" is "not private".
 */
export function privateEnough(input: { guildId: string | null; everyoneCanView: boolean | null; anywhere: boolean }) {
  if (input.anywhere) return true;
  if (!input.guildId) return true;
  return input.everyoneCanView === false;
}

/**
 * The code out of a queued event.
 *
 * The outbox is what carries a bought code to the person who bought it, so this is a link in a chain that ends
 * with somebody typing a code into the client. It used to be recovered by splitting the event's text on
 * "code " and taking the last part - which worked, and would have kept working until the sentence changed
 * somewhere else and quietly handed out half a sentence instead. The code now travels in its own column and this
 * is the single place that reads it, with the old text form still understood for events queued by an older
 * build.
 */
export function codeFromEvent(event: { kind: string; text: string; code?: string | null }): string | null {
  if (event.kind !== "paid") return null;
  if (event.code && event.code.trim()) return event.code.trim();
  const marker = event.text.lastIndexOf("code ");
  return marker >= 0 ? event.text.slice(marker + 5).trim() || null : null;
}

export type PriceCheck = { ok: true; amount: string; days: number } | { ok: false; error: string };

/**
 * The admin price modal, checked.
 *
 * Both halves matter: the amount is what goes into the `/pay` line somebody will copy, so it has to be a plain
 * number, and the days are how long a licence lasts, so a typo there is either a licence that expires in a day
 * or one that never does.
 */
export function checkPrice(amountInput: string, daysInput: string | number): PriceCheck {
  const amount = String(amountInput).trim();
  const days = typeof daysInput === "number" ? daysInput : Number(String(daysInput).trim());
  if (!/^[0-9]{1,9}(?:\.[0-9]{1,2})?$/.test(amount)) return { ok: false, error: "The amount has to be a plain number, like 5 or 7.50." };
  if (!Number.isInteger(days) || days < 1 || days > 3650) return { ok: false, error: "Days has to be a whole number from 1 to 3650." };
  if (Number(amount) <= 0) return { ok: false, error: "A plan that costs nothing is the trial - use a number above zero." };
  return { ok: true, amount, days };
}

/** The panel's buttons: the trial first, then every plan that costs something. */
export function panelButtons(plans: PlanView[]): ButtonSpec[] {
  const out: ButtonSpec[] = [];
  for (const plan of plans) if (plan.id === "trial") out.push({ id: ID.panelTrial, label: plan.label, style: "success" });
  for (const plan of plans) if (plan.id !== "trial") out.push({ id: `${ID.panelTier}${plan.id}`, label: plan.label, style: "primary" });
  return out;
}

/** The admin panel's buttons. */
export function adminButtons(): ButtonSpec[] {
  return [
    { id: ID.adminGen, label: "Generate code", style: "success" },
    { id: ID.adminPrice, label: "Set price", style: "primary" },
    { id: ID.adminOrders, label: "Open orders", style: "secondary" },
    { id: ID.adminStats, label: "Counts", style: "secondary" },
    { id: ID.adminLog, label: "Log channel = here", style: "secondary" },
  ];
}

/**
 * Which handler answers this button - the other half of the id contract, in one place.
 *
 * `bot.ts` asks these instead of containing its own list of prefixes, so a button the panel builds and the
 * handler that answers it cannot be edited apart.
 */
export const answers = {
  panel: (id: string) => id === ID.panelTrial || id.startsWith(ID.panelTier),
  ticket: (id: string) => id.startsWith(ID.ticketForm),
  order: (id: string) => id.startsWith(ID.orderCancel),
  admin: (id: string) => id.startsWith("admin:"),
} as const;

/** The tier a `panel:tier:` or `ticket:form:` id names, or null when the id is not that shape. */
export function tierFromId(id: string) {
  for (const prefix of [ID.panelTier, ID.ticketForm, ID.orderIgn]) if (id.startsWith(prefix)) return id.slice(prefix.length);
  return null;
}

