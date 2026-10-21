import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parsePlay, type Play } from "../play.ts";
import type { Developers } from "./developers.ts";
import type { Ledger } from "./ledger.ts";
import { dashboardPage } from "./dashboard.ts";

export type AppDeps = {
  ledger: Ledger;
  developers: Developers;
  // The seeded Developer the dashboard shows until GitHub sign-in exists (#8).
  dashboardDeveloperId: string;
};

const MAX_BATCH = 1000;
// Keeps idle live streams open through proxies that drop silent connections.
const KEEPALIVE_MS = 15_000;

// A Play count sent by the dashboard: a whole number, or undefined if absent or malformed.
function playCount(value: string | undefined) {
  return value !== undefined && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

export function createApp({ ledger, developers, dashboardDeveloperId }: AppDeps) {
  const app = new Hono();

  app.post("/api/plays", async (c) => {
    const key = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const developer = key ? developers.byKey(key) : undefined;
    if (!developer) return c.json({ error: "unknown PlayCount key" }, 401);

    const body = await c.req.json().catch(() => null);
    const batch: unknown = body?.plays;
    if (!Array.isArray(batch) || batch.length > MAX_BATCH) {
      return c.json({ error: `expected { plays: [...] } with at most ${MAX_BATCH} Plays` }, 400);
    }
    const plays: Play[] = [];
    for (const [i, item] of batch.entries()) {
      const p = parsePlay(item);
      if (!p) return c.json({ error: `Play ${i} is not a valid Play-log entry` }, 400);
      plays.push(p);
    }

    ledger.recordPlays(developer.id, plays);
    return c.json({ recorded: plays.length }, 202);
  });

  // The dashboard Developer's live Play stream, as Server-Sent Events. Each event is one Play,
  // and its id is that Play's number in the Play log, so the id is always the current count.
  // A reconnecting browser sends the last id it saw and gets every Play it missed.
  app.get("/api/plays/stream", (c) =>
    streamSSE(c, async (stream) => {
      const developerId = dashboardDeveloperId;
      const recorded = ledger.playsOf(developerId);
      const from = playCount(c.req.header("last-event-id")) ?? playCount(c.req.query("since")) ?? recorded.length;

      // Writes go out in order: a missed-Play replay, then live Plays as the Ledger records them.
      let writes = Promise.resolve();
      const send = (message: Parameters<typeof stream.writeSSE>[0]) => {
        writes = writes.then(() => (stream.aborted ? undefined : stream.writeSSE(message))).catch(() => {});
      };
      const sendPlay = (play: Play, number: number) => send({ id: String(number), data: JSON.stringify(play) });

      const stop = ledger.onPlays(developerId, sendPlay);
      stream.onAbort(stop);

      if (from > recorded.length) {
        // The browser has seen Plays this Ledger no longer holds (the service restarted).
        send({ event: "reset", data: "" });
      } else {
        send({ data: "", event: "hello", retry: 1000 });
        recorded.slice(from).forEach((play, i) => sendPlay(play, from + i + 1));
      }

      while (!stream.aborted) {
        await stream.sleep(KEEPALIVE_MS);
        writes = writes.then(() => (stream.aborted ? undefined : stream.write(": keepalive\n\n"))).then(() => {}, () => {});
      }
      stop();
      await writes;
    }),
  );

  app.get("/", (c) => {
    const developer = developers.byId(dashboardDeveloperId);
    const plays = developer ? ledger.playsOf(developer.id).reverse() : [];
    return c.html(dashboardPage(developer?.name ?? "Unknown developer", plays));
  });

  return app;
}
