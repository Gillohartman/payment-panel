import { api } from "./api";
import { migrate, origin } from "./auth";
await migrate();
// The Discord bot runs in this process, on purpose: Railway gives one service one volume, and the bot and the
// payment API have to see the same SQLite file for a detected payment to become a code. It is started after the
// migration and before the server listens, and `startBot` returns rather than throwing when there is no token,
// so a deployment without Discord configured is a working licence API that simply has no bot.
if (process.env.DISCORD_TOKEN) {
  try {
    const { startBot } = await import("./bot");
    await startBot();
  } catch (e) {
    console.error(`[bot] could not start: ${e instanceof Error ? e.message : e}`);
  }
}
const security = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
};
// This process is the key system alone. It used to serve the site's pages from ./public as well; those are gone
// with the website folder, so every path that is not the API is a 404 - which is what the Discord bot, the
// panel's own API calls and the mod's three /api/license endpoints need and nothing else.
```ts
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT || new URL(origin).port || 4318),
  maxRequestBodySize: 21_000_000,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });
    const headers = new Headers(req.headers);
    // Do not trust a browser-supplied address for rate limiting.
    headers.set("x-revolution-rate-key", server.requestIP(req)?.address ?? "local");
    const response = await api(new Request(req, { headers }));
    for (const [key, value] of Object.entries(security)) response.headers.set(key, value);
    return response;
  },
});

console.log("Revolution Client key system ready at " + server.url);
console.log(`Revolution Client key system ready at $DIL0`);
</CodeBlock>
