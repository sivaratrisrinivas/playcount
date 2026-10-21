import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parsePlay, type Play } from "../play.ts";
import type { Developers } from "./developers.ts";
import type { Ledger } from "./ledger.ts";
import { dashboardPage, playRow } from "./dashboard.ts";

export type AppDeps = {
  ledger: Ledger;
  developers: Developers;
  // The seeded Developer the dashboard shows until GitHub sign-in exists (#8).
  dashboardDeveloperId: string;
};

const MAX_BATCH = 1000;
// Keeps idle live streams open through proxies that drop silent connections.
const KEEPALIVE_MS = 15_000;

// How long a browser waits before reconnecting a dropped live stream.
const RETRY_MS = 1000;
const noop = () => {};

function parseCursor(value: string) {
  const match = value.match(/^([a-z0-9]{1,20})\.(\d{1,9})$/);
  return match ? { run: match[1], count: Number(match[2]) } : undefined;
}

export function createApp({ ledger, developers, dashboardDeveloperId }: AppDeps) {
  const app = new Hono();
  // Names this service run in stream cursors, so a browser's cursor from an earlier run is spotted.
  const run = (Date.now() + Math.random()).toString(36).replace(".", "");
  const cursor = (count: number) => `${run}.${count}`;

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
  // rendered as a dashboard row. Its id is a cursor: this service run, then the Play's number
  // in the Play log, which is the Developer's count once that Play is shown. A reconnecting
  // browser sends the last cursor it saw and gets every Play it missed.
  app.get("/api/plays/stream", (c) => {
    if (!developers.byId(dashboardDeveloperId)) return c.notFound();
    return streamSSE(c, async (stream) => {
      const recorded = ledger.playsOf(dashboardDeveloperId);
      const from = parseCursor(c.req.header("last-event-id") ?? c.req.query("since") ?? cursor(recorded.length));

      // Writes go out in order: a missed-Play replay, then live Plays as the Ledger records them.
      let writes = Promise.resolve();
      const write = (next: () => Promise<unknown>) => {
        writes = writes.then(() => (stream.aborted ? undefined : next())).then(noop, noop);
      };
      const sendPlay = (play: Play, number: number) =>
        write(() => stream.writeSSE({ id: cursor(number), data: String(playRow(play)) }));

      const stop = ledger.onPlays(dashboardDeveloperId, sendPlay);
      stream.onAbort(stop);

      if (from?.run !== run || from.count > recorded.length) {
        // The browser's cursor is from another service run, whose in-memory Ledger is gone.
        write(() => stream.writeSSE({ event: "reset", data: "", retry: RETRY_MS }));
      } else {
        write(() => stream.writeSSE({ event: "hello", data: "", retry: RETRY_MS }));
        recorded.slice(from.count).forEach((play, i) => sendPlay(play, from.count + i + 1));
      }

      while (!stream.aborted) {
        await stream.sleep(KEEPALIVE_MS);
        write(() => stream.write(": keepalive\n\n"));
      }
      stop();
      await writes;
    });
  });

  app.get("/", (c) => {
    const developer = developers.byId(dashboardDeveloperId);
    const plays = developer ? ledger.playsOf(developer.id).reverse() : [];
    return c.html(dashboardPage(developer?.name ?? "Unknown developer", plays, cursor(plays.length)));
  });

  return app;
}
