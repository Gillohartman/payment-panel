# keysystem

The client's key system: the **Discord bot**, the **payment-detection API** and the **codes they hand out**. The
client half is the *Licence* module in the mod; this folder is everything it talks to.

It was the `website/` folder until the site itself was dropped. The pages, the static hosting and the site's own
build are gone; the backend stayed because the bot, the API and the database are one service, and the mod's
`/api/license/` endpoints live in the same router.

| file | what it is |
| --- | --- |
| `licensing.ts` | **The rules.** Plans, orders, payments, codes, sessions, the outbox, housekeeping. Every function takes the database as a parameter, which is what lets the whole rule set be tested without Discord, a network or a game. |
| `bot.ts` | **The Discord half.** `/panel`, the trial gate, tickets, the payment panel with the name modal, the admin panel, the log channel and the outbox that DMs codes. It decides nothing; it only asks `licensing.ts`. |
| `discord-rules.ts` | What the bot decides, with Discord taken out of it: button ids and the predicates that answer them, the trial gate, the private-channel rule, the price check, escaping, ticket names. |
| `api.ts` | The mod's three endpoints under `/api/license/`, plus the account, news, release and device-pairing routes the site's API already had. |
| `auth.ts` | The database, and where `installLicensing` is called so the API, the bot and the tests all share one migration path. |
| `index.ts` | The process: migrate, start the bot if `DISCORD_TOKEN` is set, then serve `/api/` — and nothing else. |

To install dependencies:

```bash
bun install
```

To run the API and the bot together:

```bash
bun run index.ts
```

The bot runs inside `index.ts` when `DISCORD_TOKEN` is set, so one deployment serves the API and the bot against
one database; `bun run bot` runs it on its own against the same `DATA_DIR` if you would rather split them.

To check your work before pushing:

```bash
bun test           # the licensing rules, the Discord half and the API
bun run typecheck
```

The customer data lives in `data/revolution.sqlite`, the keys in `.env` (neither is committed). Deployment and
the whole design are written up in [../docs/licensing.md](../docs/licensing.md).
