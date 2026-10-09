import type { Database } from "bun:sqlite";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits,
  GuildMember, MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, type Channel, type Interaction, type TextChannel,
} from "discord.js";
import { db as siteDb } from "./auth";
import {
  adminToken, cancelOrder, createOrder, getSetting, markPosted, mintForTier, openOrders, payCommand, purge,
  setSetting, setTier, stats, tiers, trialUsed, unpostedEvents,
} from "./licensing";
import {
  answers, adminButtons, checkPrice, codeFromEvent, esc, ID, panelButtons, privateEnough, tierFromId, ticketName,
  trialAllowed, type ButtonSpec,
} from "./discord-rules";

/**
 * The Discord half of the key system: the panel a buyer presses, the ticket that opens, the payment line they
 * copy out, and the admin panel that mints codes without a payment.
 *
 * It holds no rules. Everything that decides something - who paid, whether a code is still good, what a tier
 * costs and for how long - lives in `licensing.ts` against the same SQLite file, and this file only ever asks.
 * That is deliberate: the rules are the part that has to be right, and being outside the Discord connection is
 * what lets them be tested at all.
 *
 * Two things are the shape of this whole file:
 *
 *   - **A code is never public.** A code leaves this file in exactly three ways: an ephemeral reply only its
 *     buyer can read, a DM, and the admin log channel. The log channel is the deliberate third one - it is set
 *     with `/admin log`, which refuses to run outside a private channel, and it is where an admin recovers a
 *     paid code whose DM could not be delivered. A code in a channel everybody can read is a code somebody
 *     else activates, which is why nothing else here prints one.
 *   - **A failure here cannot stop the API.** `startBot()` returns rather than throwing when the token, the
 *     guild or Discord itself is missing, so the payment API keeps working while the bot is down.
 *
 * The order the buyer walks through, since it is spread over four handlers and is not obvious from any one of
 * them: press a plan on the panel -> a private ticket is created and the bot asks for a name in **there** ->
 * pressing that button shows the modal -> the submitted name becomes the order, and the payment line is posted
 * in the ticket. Nothing about the buyer is ever posted where other people can read it.
 */

/**
 * The database every handler works on.
 *
 * One variable, so a test can point the handlers at a database of its own.
 *
 * This seam exists because the alternative is worse: the handlers are the part of this file that a buyer walks
 * through - press a plan, type a name, cancel an order - and without it none of that could be tested without a
 * live Discord connection and a live site database, which is to say never in a build environment. Everything
 * else in here is Discord plumbing that a fake cannot meaningfully stand in for.
 */
let active: Database = siteDb;

export function useDatabase(database: Database) {
  active = database;
}

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const admins = (process.env.ADMIN_DISCORD_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const trialMinAgeDays = Number(process.env.TRIAL_MIN_ACCOUNT_DAYS ?? 7);

let client: Client | null = null;

/**
 * Where log lines go, in the order the answer should be: the admin's choice, then the environment, then nowhere.
 *
 * Read rather than held: a `let` seeded at import time is one the admin panel can move and a redeploy silently
 * undoes, and this file is imported before the tables exist on a fresh database, so nothing here may touch the
 * database until a handler runs.
 */
const logChannel = () => getSetting(active, "log_channel", process.env.LICENSE_LOG_CHANNEL ?? "");

/** The connected client, or a clear error - so no handler has to reason about a half-started bot. */
function bot() {
  if (!client) throw new Error("The bot is not connected.");
  return client;
}

/**
 * A line to the process log, verbatim.
 *
 * `esc` is for text on its way into a Discord message and is applied there, at the message. Running the log
 * through it was wrong in a small but real way: it escaped the underscores in `DISCORD_TOKEN`, put an invisible
 * zero-width space in every `@` a caller mentioned, and cut everything off at 300 characters - so the console
 * showed something that was not what the bot had said. A log is for reading what happened.
 */
const log = (text: string) => console.log(`[bot] ${text}`);

/** A row of buttons from the specs `discord-rules.ts` builds, so the ids come from one place. */
function buttonRow(specs: ButtonSpec[]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...specs.map(spec => {
    const button = new ButtonBuilder().setCustomId(spec.id).setLabel(spec.label);
    if (spec.style === "success") return button.setStyle(ButtonStyle.Success);
    if (spec.style === "primary") return button.setStyle(ButtonStyle.Primary);
    if (spec.style === "danger") return button.setStyle(ButtonStyle.Danger);
    return button.setStyle(ButtonStyle.Secondary);
  }));
}

function panelEmbed() {
  const embed = new EmbedBuilder()
    .setTitle("Revolution Client")
    .setDescription("Press a plan below. The trial gives a code straight away; a paid plan opens a private ticket.")
    .setColor(0x39ff14);
  for (const tier of tiers(active)) {
    embed.addFields({
      name: `${tier.label}${tier.price > 0 ? ` - ${tier.price}` : " - free"}`,
      value: tier.id === "trial" ? "1 day, once per account." : `${tier.days} days.`,
      inline: true,
    });
  }
  return embed;
}

const panelRow = () => buttonRow(panelButtons(tiers(active)));
const adminRow = () => buttonRow(adminButtons());

/** The open orders, as one message. Shared by the `/admin orders` command and its button. */
function orderList() {
  const rows = openOrders(active).slice(0, 20);
  if (!rows.length) return "Nothing open.";
  return `Open orders (${rows.length}):\n` + rows
    .map(o => `${esc(o.ign)} - ${esc(o.amount)} - <@${o.discord_id}> - ${Math.round((Date.now() - o.created) / 60000)}m`)
    .join("\n");
}

/** The counts, as one message. Same two callers as above. */
function counts() {
  const snapshot = stats(active);
  return `Open ${snapshot.open} | paid ${snapshot.paid} | unmatched payments ${snapshot.unmatched} | `
    + `codes ${snapshot.codes} (${snapshot.used} used) | active licences ${snapshot.active}`;
}

/** The one thing `privateChannel` needs from a channel, so the check does not have to be a cast soup. */
type PermissionLookup = { permissionsFor?: (role: unknown) => { has: (flag: bigint) => boolean } | null };

/**
 * Whether this interaction is private enough for the admin panel.
 *
 * The rule the panel is asked to keep is "only in private places", and Discord has no "is this channel private"
 * flag - what it has is the permission everybody else has on it. @everyone without View Channel is that
 * definition, so that is what is checked, and a DM (no guild) passes by definition. `ADMIN_PANEL_ANYWHERE=1` is
 * the escape hatch for an admin who wants it in a staff channel everyone can read.
 */
function privateChannel(interaction: Interaction) {
  const anywhere = process.env.ADMIN_PANEL_ANYWHERE === "1";
  if (!interaction.guildId || !interaction.guild) {
    return privateEnough({ guildId: null, everyoneCanView: null, anywhere });
  }
  const channel = interaction.channel as (Channel & PermissionLookup) | null;
  // "I could not read the permission" reads as not-private on purpose: the safe answer for a panel that hands
  // out codes is to refuse rather than to guess.
  const everyone = channel && typeof channel.permissionsFor === "function"
    ? channel.permissionsFor(interaction.guild.roles.everyone) : null;
  return privateEnough({ guildId: interaction.guildId, everyoneCanView: everyone?.has(PermissionFlagsBits.ViewChannel) ?? null, anywhere });
}

const isAdmin = (id: string) => admins.includes(id);

/**
 * The trial gate.
 *
 * Discord does not expose email verification to bots, so "only verified accounts" cannot be checked directly.
 * The two honest proxies are an account old enough not to be a throwaway, and a role you hand out yourself -
 * and when the role is configured it is the only thing that counts, because that is the one you actually
 * control. This is stated here rather than silently approximated, so nobody reads the button as a proof.
 */
function mayTakeTrial(interaction: Interaction) {
  const role = process.env.TRIAL_ROLE_ID;
  const member = interaction.member instanceof GuildMember ? interaction.member : null;
  return trialAllowed({
    accountCreatedAt: interaction.user.createdTimestamp,
    hasTrialRole: role ? Boolean(member?.roles.cache.has(role)) : false,
    minAgeDays: trialMinAgeDays,
  });
}

const trialCode = (discordId: string) => {
  try {
    // `mintForTier` with the trial as its own source, not the admin path: a free day is not an admin code, and
    // the difference is what the log lines and the counts are read for. This was wrong until the trial test
    // asked the store what had been minted and got "admin" back.
    return mintForTier(active, "trial", "trial", discordId);
  } catch {
    // The tier was renamed away in the admin panel: a message, not a thrown handler.
    return null;
  }
};

/**
 * What the outbox needs from Discord: a DM, and a line in the log channel. Nothing else.
 *
 * A pair of calls rather than the client itself, because the outbox is the end of the chain that matters most -
 * a payment is detected, a code is minted, and this is what puts that code in front of the buyer. Leaving it
 * reachable only through a live gateway meant the last link was the one link no test could reach. With this
 * seam, `deliver` is driven by a fake that records what it was asked to say, and the test can assert the string
 * that would arrive in the buyer's DMs is the string the store minted.
 *
 * Both calls answer whether the message actually went out. A DM that was refused (a closed inbox, a user who
 * blocked the bot) is the one failure an admin has to be told about, because the code exists and nobody has it.
 */
export type Delivery = {
  dm(discordId: string, content: string): Promise<boolean>;
  logLine(channelId: string, content: string): Promise<boolean>;
};

/** The real delivery, built from the connected client - and built per call, so this touches `bot()` only when
 * somebody actually presses something rather than at import, when there may be no client at all. */
function liveDelivery(): Delivery {
  return {
    async dm(discordId, content) {
      const user = await bot().users.fetch(discordId).catch(() => null);
      if (!user) return false;
      return user.send({ content }).then(() => true).catch(() => false);
    },
    async logLine(channelId, content) {
      const channel = await bot().channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased() || !channel.isSendable()) return false;
      return channel.send({ content, allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
    },
  };
}

/**
 * One line per event into the log channel, and a DM when the event names somebody.
 *
 * Each event is delivered on its own and marked posted in a `finally`, so one closed DM or one Discord hiccup
 * cannot hold the whole queue behind it - which is the failure mode that would otherwise turn a successful
 * payment into a silent one.
 */
export async function deliver(delivery: Delivery = liveDelivery()) {
  for (const event of unpostedEvents(active)) {
    try {
      if (event.discord_id && event.kind === "paid") {
        // The code comes out of its own field - see codeFromEvent, which is the one place that reads it.
        const code = codeFromEvent(event);
        const sent = await delivery.dm(event.discord_id, code
          ? `Your payment came in. Your code:\n\`\`\`\n${code}\n\`\`\`\nActivate it in the client under Key. It works once.`
          : "Your payment came in, but the code could not be read. Ask an admin - the log has the line.");
        if (!sent) log(`could not DM ${event.discord_id} - the code is in the log`);
      }
      const logChannelId = logChannel();
      if (logChannelId) {
        const written = await delivery.logLine(logChannelId, `\`${event.kind}\` ${esc(event.text)}`);
        if (!written) log("could not write to the log channel");
      }
    } finally {
      markPosted(active, event.id);
    }
  }
}

/** Runs `fn` on an interval and never lets a rejection become an unhandled one. */
function every(ms: number, fn: () => Promise<void> | void) {
  const run = () => { void Promise.resolve().then(fn).catch(e => log(`interval failed: ${e instanceof Error ? e.message : e}`)); };
  const timer = setInterval(run, ms);
  timer.unref?.();
  return timer;
}

/**
 * What the gateway calls for one interaction: one entry point, so the routing is a thing that can be tested.
 *
 * The order matters and is not obvious. The price modal is asked first because its id shares the `admin:price`
 * prefix the button handler also answers, and a modal submit that fell through to `handleButton` would be
 * answered with a message no user can see. After that each interaction type goes to the handler that owns it,
 * and a modal submit that is not a price modal is the name modal - the last one, because it is the only
 * remaining kind. `startBot` wraps this whole call in one catch, which is why nothing in here has to.
 */
export async function dispatch(interaction: Interaction) {
  if (await handlePriceModal(interaction)) return;
  if (interaction.isChatInputCommand()) return handleCommand(interaction);
  if (interaction.isButton()) return handleButton(interaction);
  if (interaction.isStringSelectMenu()) return handleSelect(interaction);
  return handleOrderModal(interaction);
}

export async function handleCommand(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "panel") {
    await interaction.reply({ embeds: [panelEmbed()], components: [panelRow()] });
    return;
  }
  if (interaction.commandName !== "admin") return;
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "Not for you.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!privateChannel(interaction)) {
    await interaction.reply({ content: "Use this in a private channel or a DM.", flags: MessageFlags.Ephemeral });
    return;
  }
  // `/admin panel` opens the buttons, and the rest of the subcommands are the same work without pressing
  // anything - which is what a price change wants to be, since a button reply is easy to lose among messages.
  const sub = interaction.options.getSubcommand();
  if (sub === "panel") {
    await interaction.reply({
      content: "Admin panel. Every code this shows is ephemeral - only you can see it.",
      components: [adminRow()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (sub === "code") {
    const plan = interaction.options.getString("plan", true).trim().toLowerCase();
    if (!tiers(active).some(t => t.id === plan)) {
      await interaction.reply({ content: `No plan called ${esc(plan)}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const code = adminToken(active, plan, interaction.user.id);
    await interaction.reply({
      content: `Code for **${esc(plan)}** (${code.days} days), no payment taken:\n\`\`\`\n${code.token}\n\`\`\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (sub === "price") {
    const plan = interaction.options.getString("plan", true).trim().toLowerCase();
    const checked = checkPrice(interaction.options.getString("amount", true), interaction.options.getInteger("days", true));
    if (!checked.ok) {
      await interaction.reply({ content: checked.error, flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      setTier(active, plan, { pay_amount: checked.amount, days: checked.days });
      await interaction.reply({
        content: `${esc(plan)} is now ${esc(checked.amount)} for ${checked.days} days. The next ticket quotes it.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      await interaction.reply({ content: e instanceof Error ? e.message : "Could not set that.", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (sub === "orders") {
    await interaction.reply({ content: orderList(), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  if (sub === "stats") {
    await interaction.reply({ content: counts(), flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === "log") {
    setSetting(active, "log_channel", interaction.channelId);
    await interaction.reply({
      content: `Log lines now go to <#${interaction.channelId}>, and that survives a restart.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

/**
 * Creates the private place the buyer and the bot talk in.
 *
 * A channel rather than a private thread: private threads need a server that has them, and a channel with
 * @everyone denied is the one thing that works everywhere and can be read by an admin afterwards.
 */
async function openTicket(interaction: Interaction, tierId: string): Promise<TextChannel | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  // Who gets access: @everyone is denied, the buyer is allowed, and so is the application that is opening the
  // ticket. The application comes off the interaction rather than from this module's own client - it is the same
  // id, and the interaction is the thing that is known to be live. Reaching for `bot()` here meant a ticket was
  // silently refused ("I could not open a ticket") whenever the client was not ready, which is a poor trade for
  // a value the interaction already carries.
  const overwrites: { id: string; deny?: bigint[]; allow?: bigint[] }[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  const application = interaction.client?.user?.id;
  if (application) overwrites.push({
    id: application,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
  });
  try {
    return await guild.channels.create({
      name: ticketName(tierId, interaction.user.username),
      type: ChannelType.GuildText,
      parent: process.env.LICENSE_TICKET_CATEGORY || undefined,
      permissionOverwrites: overwrites,
    });
  } catch (e) {
    log(`ticket creation failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function handleButton(interaction: Interaction) {
  if (!interaction.isButton()) return;
  const id = interaction.customId;

  if (id === ID.panelTrial) {
    if (!mayTakeTrial(interaction)) {
      await interaction.reply({
        content: process.env.TRIAL_ROLE_ID
          ? "The free day is for accounts with the trial role - ask for it first."
          : `The free day is for established accounts (${trialMinAgeDays} days minimum).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Once per account, before anything is minted: the panel promises it, and a day that can be re-pressed is
    // a free licence rather than a trial - see `trialUsed`, which is the query that makes the promise true.
    if (trialUsed(active, interaction.user.id)) {
      await interaction.reply({ content: "You have already had the free day.", flags: MessageFlags.Ephemeral });
      return;
    }
    const code = trialCode(interaction.user.id);
    if (!code) {
      await interaction.reply({ content: "The trial plan is not configured. Tell an admin.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({
      content: `Your code:\n\`\`\`\n${code.token}\n\`\`\`\nActivate it in the client under Key. Good for ${code.days} day(s), once.`,
      flags: MessageFlags.Ephemeral,
    });
    await interaction.user.send({ content: `Your trial code:\n\`\`\`\n${code.token}\n\`\`\`` }).catch(() => undefined);
    return;
  }

  if (id.startsWith(ID.panelTier)) {
    const tierId = tierFromId(id) ?? "";
    const tier = tiers(active).find(t => t.id === tierId);
    if (!tier) {
      await interaction.reply({ content: "That plan is gone.", flags: MessageFlags.Ephemeral });
      return;
    }
    const ticket = await openTicket(interaction, tierId);
    if (!ticket) {
      await interaction.reply({ content: "I could not open a ticket. Tell an admin.", flags: MessageFlags.Ephemeral });
      return;
    }
    // The name is asked for *inside the ticket*: that is what keeps the order, the in-game name and the payment
    // line out of the public channel the panel sits in.
    await ticket.send({
      content: `<@${interaction.user.id}> - press the button and enter your Minecraft name exactly as you type it in game.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${ID.ticketForm}${tierId}`).setLabel("Enter my name").setStyle(ButtonStyle.Primary))],
    });
    await interaction.reply({ content: `Opened <#${ticket.id}> for you.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (id.startsWith(ID.ticketForm)) {
    const tierId = tierFromId(id) ?? "";
    const modal = new ModalBuilder().setCustomId(`${ID.orderIgn}${tierId}`).setTitle("Your Minecraft name")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("ign").setLabel("Name exactly as in game")
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16)));
    await interaction.showModal(modal);
    return;
  }

  if (id.startsWith(ID.orderCancel)) {
    const orderId = id.slice(ID.orderCancel.length);
    const row = openOrders(active).find(o => o.id === orderId);
    if (!row) {
      await interaction.reply({ content: "That order is no longer open.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Only the buyer or an admin may call it off; anything else is somebody cancelling a stranger's order.
    if (row.discord_id !== interaction.user.id && !isAdmin(interaction.user.id)) {
      await interaction.reply({ content: "That is not your order.", flags: MessageFlags.Ephemeral });
      return;
    }
    cancelOrder(active, orderId);
    await interaction.reply({ content: "Order cancelled. Open a ticket again whenever you want." });
    return;
  }

  if (!answers.admin(id)) return;
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "Not for you.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!privateChannel(interaction)) {
    await interaction.reply({ content: "Use this in a private channel or a DM.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (id === ID.adminGen) {
    await interaction.reply({
      content: "Generate a code for which plan?",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(ID.adminGenTier).setPlaceholder("Which plan?")
          .addOptions(tiers(active).map(t => ({ label: t.label, value: t.id }))))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (id === ID.adminPrice) {
    await interaction.reply({
      content: "Set the payment amount for which plan?",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(ID.adminPriceTier).setPlaceholder("Which plan?")
          .addOptions(tiers(active).map(t => ({ label: `${t.label} (${t.pay_amount})`, value: t.id }))))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (id === ID.adminOrders) {
    await interaction.reply({ content: orderList(), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  if (id === ID.adminLog) {
    setSetting(active, "log_channel", interaction.channelId);
    await interaction.reply({
      content: `Log lines go to <#${interaction.channelId}>, and that survives a restart.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({ content: counts(), flags: MessageFlags.Ephemeral });
}

/** The name the buyer typed becomes the order, and the panel that quotes the payment appears in the ticket. */
export async function handleOrderModal(interaction: Interaction) {
  if (!interaction.isModalSubmit()) return;
  const id = interaction.customId;
  if (!id.startsWith(ID.orderIgn)) return;
  const tierId = id.slice(ID.orderIgn.length);
  const tier = tiers(active).find(t => t.id === tierId);
  if (!tier) {
    await interaction.reply({ content: "That plan is gone.", flags: MessageFlags.Ephemeral });
    return;
  }
  let order;
  try {
    order = createOrder(active, { discordId: interaction.user.id, ign: interaction.fields.getTextInputValue("ign"), tierId, channelId: interaction.channelId });
  } catch (e) {
    await interaction.reply({ content: e instanceof Error ? e.message : "That name was rejected.", flags: MessageFlags.Ephemeral });
    return;
  }
  const embed = new EmbedBuilder().setTitle(`${tier.label} - payment`).setColor(0xffc300)
    .setDescription(
      `You are buying **${tier.days} days** for \`${esc(order.ign)}\`.\n\n`
      + "1. Join the server and run exactly this line:\n"
      + `\`\`\`\n${payCommand(order.amount, order.ign)}\n\`\`\`\n`
      + "2. Keep this ticket open. The payment is picked up within a couple of minutes and the code comes to you "
      + "as a DM.\n\n"
      + "If the order runs out before you pay, cancel it and open a new ticket.");
  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${ID.orderCancel}${order.id}`).setLabel("Cancel this order").setStyle(ButtonStyle.Danger))],
  });
}

/** The admin price modal: what a plan costs, changed from Discord rather than from a redeploy. */
export async function handlePriceModal(interaction: Interaction): Promise<boolean> {
  if (!interaction.isModalSubmit()) return false;
  const id = interaction.customId;
  if (!id.startsWith(`${ID.adminPrice}:`)) return false;
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "Not for you.", flags: MessageFlags.Ephemeral });
    return true;
  }
  const tierId = id.slice(`${ID.adminPrice}:`.length);
  // The same check the `/admin price` command uses, so the two paths cannot disagree about what a price is.
  const checked = checkPrice(interaction.fields.getTextInputValue("amount"), interaction.fields.getTextInputValue("days"));
  if (!checked.ok) {
    await interaction.reply({ content: checked.error, flags: MessageFlags.Ephemeral });
    return true;
  }
  try {
    setTier(active, tierId, { pay_amount: checked.amount, days: checked.days });
    await interaction.reply({ content: `${esc(tierId)} is now ${esc(checked.amount)} for ${checked.days} days. The next ticket quotes it.`, flags: MessageFlags.Ephemeral });
  } catch (e) {
    await interaction.reply({ content: e instanceof Error ? e.message : "Could not set that.", flags: MessageFlags.Ephemeral });
  }
  return true;
}

export async function handleSelect(interaction: Interaction) {
  if (!interaction.isStringSelectMenu()) return;
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "Not for you.", flags: MessageFlags.Ephemeral });
    return;
  }
  const choice = interaction.values[0] ?? "";
  if (interaction.customId === ID.adminGenTier) {
    try {
      const code = adminToken(active, choice, interaction.user.id);
      await interaction.reply({
        content: `Code for **${esc(choice)}** (${code.days} days), no payment taken:\n\`\`\`\n${code.token}\n\`\`\``,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      await interaction.reply({ content: e instanceof Error ? e.message : "Could not mint.", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (interaction.customId === ID.adminPriceTier) {
    const tier = tiers(active).find(t => t.id === choice);
    if (!tier) return;
    await interaction.showModal(new ModalBuilder().setCustomId(`${ID.adminPrice}:${tier.id}`)
      .setTitle(`${tier.label} - price and days`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("amount").setLabel("Amount in the /pay line").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(12).setValue(String(tier.pay_amount))),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("days").setLabel("Days the licence lasts").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(5).setValue(String(tier.days)))));
  }
}

/**
 * The two commands, built when the bot starts rather than at import.
 *
 * They were a module-level constant until the admin one needed subcommands, and building them here is the right
 * shape anyway: it keeps this file importable without a migrated database, which is what makes it testable.
 */
function commands() {
  const admin = new SlashCommandBuilder().setName("admin")
    .setDescription("Admin tools (private channels only)")
    .addSubcommand(sub => sub.setName("panel").setDescription("The same tools as buttons"))
    .addSubcommand(sub => sub.setName("code").setDescription("Mint a code with no payment")
      .addStringOption(o => o.setName("plan").setDescription("Plan id: trial, monthly or yearly").setRequired(true)))
    .addSubcommand(sub => sub.setName("price").setDescription("Set a plan's amount and length")
      .addStringOption(o => o.setName("plan").setDescription("Plan id: trial, monthly or yearly").setRequired(true))
      .addStringOption(o => o.setName("amount").setDescription("What the /pay line asks for").setRequired(true))
      .addIntegerOption(o => o.setName("days").setDescription("How long the licence lasts").setRequired(true)))
    .addSubcommand(sub => sub.setName("orders").setDescription("Open orders"))
    .addSubcommand(sub => sub.setName("stats").setDescription("Open, paid, codes, active licences"))
    .addSubcommand(sub => sub.setName("log").setDescription("Send log lines to this channel"));
  return [
    new SlashCommandBuilder().setName("panel").setDescription("Show the plans and get a code").toJSON(),
    admin.toJSON(),
  ];
}

/**
 * Starts the bot. Never throws, and answers whether it is running.
 *
 * The API is the thing that must not go down, so a missing token or a Discord outage on boot is logged and
 * swallowed rather than raised - `index.ts` starts the bot inside a running server and cannot be taken down by
 * it. The return value exists for the other caller: `bun run bot` is only the bot, so there a refusal has to be
 * an exit code rather than a log line somebody may never read.
 */
export async function startBot(): Promise<boolean> {
  if (!token || !guildId) {
    log("DISCORD_TOKEN or DISCORD_GUILD_ID is not set - the bot stays off and the API runs without it.");
    return false;
  }
  try {
    client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages] });
    client.on(Events.InteractionCreate, (interaction) => {
      // One catch around all of them: a failed interaction is a message the user never gets, and letting that
      // rejection escape would take the process with it.
      void dispatch(interaction).catch(e => log(`interaction failed: ${e instanceof Error ? e.message : e}`));
    });
    client.on(Events.Error, e => log(`gateway error: ${e.message}`));
    await client.login(token);
    const application = client.application;
    if (application) {
      // Guild commands, not global ones: they are live immediately, so a changed panel or a new admin button
      // takes effect on the next use rather than on Discord's own schedule.
      await application.commands.set(commands(), guildId).catch(e => log(`command registration failed: ${e.message}`));
    }
    // Wrapped rather than handed over as `deliver` itself: the interval would otherwise call it with the promise
    // callback's own argument, which happens to be `undefined` and therefore happens to hit the default. Relying
    // on that is the kind of thing a later signature change breaks silently.
    every(5_000, () => deliver());
    every(6 * 60 * 60 * 1000, () => {
      const result = purge(active);
      log(`housekeeping: ${result.tokens} codes removed, ${result.sessions} sessions forgotten`);
    });
    log(`connected as ${client.user?.tag ?? "?"}`);
    return true;
  } catch (e) {
    // A Discord outage on boot is not an API outage: log it and leave `client` null so nothing else runs.
    log(`could not start: ${e instanceof Error ? e.message : e}`);
    client = null;
    return false;
  }
}

/**
 * `bun run bot` - the bot alone, against the same `DATA_DIR` as the API.
 *
 * The documented alternative to running it inside `index.ts`, for splitting the two onto separate services. The
 * script was in `package.json` and the deploy notes mentioned it before there was anything for it to do: this
 * file exported `startBot` and nothing called it, so the command imported a module and exited 0 as if it had
 * worked. A bot that is not running is a bot nobody notices is not running, which is why the failure to start is
 * an exit code here rather than a line in a log.
 *
 * `migrate()` runs first for the same reason `index.ts` runs it: started against a fresh volume, the bot's very
 * first handler would otherwise be the thing that creates the tables, and every read before it would find none.
 */
if (import.meta.main) {
  const { migrate } = await import("./auth");
  await migrate();
  if (!(await startBot())) {
    console.error("[bot] not running - set DISCORD_TOKEN and DISCORD_GUILD_ID, or run the site with `bun run start`, which serves without the bot.");
    process.exit(1);
  }
}
