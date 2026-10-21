import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parsePlay, type Play } from "../play.ts";
import type { Developers } from "./developers.ts";
import type { Ledger } from "./ledger.ts";
import { dashboardPage, playRow } from "./dashboard.ts";
import { isPeriod, periodOf, statementOf } from "./statement.ts";

export type AppDeps = {
  ledger: Ledger;
  developers: Developers;
  // The seeded Developer the dashboard shows until GitHub sign-in exists (#8).
  dashboardDeveloperId: string;
  // Decides the current period; tests pass a fixed one.
  clock?: () => Date;
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

// AG Grid is served from the installed package so the dashboard works without a CDN.
// The browser bundle isn't in the package's exports, so it is found next to the main entry.
const AG_GRID = join(dirname(createRequire(import.meta.url).resolve("ag-grid-community")), "..", "ag-grid-community.min.js");

export function createApp({ ledger, developers, dashboardDeveloperId, clock = () => new Date() }: AppDeps) {
  const app = new Hono();
  // Names this service run in stream cursors, so a browser's cursor from an earlier run is spotted.
  const run = (Date.now() + Math.random()).toString(36).replace(".", "");
  const cursor = (count: number) => `${run}.${count}`;

  const developerOf = (c: Context) => {
    const key = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    return key ? developers.byKey(key) : undefined;
  };

  app.post("/api/plays", async (c) => {
    const developer = developerOf(c);
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

  // The dashboard Developer's live Play stream, as Server-Sent Events. Each Play event is one
  // Play, rendered as a dashboard row, and its id is a cursor: this service run, then the Play's
  // number in the Play log, which is the Developer's count once that Play is shown. A reconnecting
  // browser sends the last cursor it saw and gets every Play it missed. "statement" events carry
  // the current period's statement as it changes.
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
      // After new Plays, one statement follows them, computed when it is written, so a batch
      // of Plays costs one statement rather than one each.
      let statementQueued = false;
      const sendPlay = (play: Play, number: number) => {
        write(() => stream.writeSSE({ id: cursor(number), data: String(playRow(play)) }));
        if (statementQueued) return;
        statementQueued = true;
        write(() => {
          statementQueued = false;
          const statement = statementOf(ledger.playsOf(dashboardDeveloperId), periodOf(clock()));
          return stream.writeSSE({ event: "statement", data: JSON.stringify(statement) });
        });
      };

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

  app.get("/api/statement", (c) => {
    const developer = developerOf(c);
    if (!developer) return c.json({ error: "unknown PlayCount key" }, 401);
    const period = c.req.query("period") ?? periodOf(clock());
    if (!isPeriod(period)) return c.json({ error: "period must be a month written YYYY-MM" }, 400);
    return c.json(statementOf(ledger.playsOf(developer.id), period));
  });

  // Render polls this before switching traffic to a new deploy.
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/", (c) => {
    const developer = developers.byId(dashboardDeveloperId);
    const plays = developer ? ledger.playsOf(developer.id).reverse() : [];
    const statement = statementOf(plays, periodOf(clock()));
    return c.html(dashboardPage(developer?.name ?? "Unknown developer", plays, statement, cursor(plays.length)));
  });

  let agGrid: Promise<string> | undefined;
  app.get("/vendor/ag-grid-community.min.js", async (c) => {
    agGrid ??= readFile(AG_GRID, "utf8").catch((err) => {
      agGrid = undefined;
      throw err;
    });
    c.header("cache-control", "public, max-age=86400");
    return c.body(await agGrid, 200, { "content-type": "text/javascript; charset=utf-8" });
  });

  return app;
}
