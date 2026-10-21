import { Hono, type Context } from "hono";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parsePlay, type Play } from "../play.ts";
import type { Developers } from "./developers.ts";
import type { Ledger } from "./ledger.ts";
import { dashboardPage } from "./dashboard.ts";
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

// AG Grid is served from the installed package so the dashboard works without a CDN.
// The browser bundle isn't in the package's exports, so it is found next to the main entry.
const AG_GRID = join(dirname(createRequire(import.meta.url).resolve("ag-grid-community")), "..", "ag-grid-community.min.js");

export function createApp({ ledger, developers, dashboardDeveloperId, clock = () => new Date() }: AppDeps) {
  const app = new Hono();

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

  app.get("/api/statement", (c) => {
    const developer = developerOf(c);
    if (!developer) return c.json({ error: "unknown PlayCount key" }, 401);
    const period = c.req.query("period") ?? periodOf(clock());
    if (!isPeriod(period)) return c.json({ error: "period must be a month written YYYY-MM" }, 400);
    return c.json(statementOf(ledger.playsOf(developer.id), period));
  });

  app.get("/", (c) => {
    const developer = developers.byId(dashboardDeveloperId);
    const plays = developer ? ledger.playsOf(developer.id).reverse() : [];
    const statement = statementOf(plays, periodOf(clock()));
    return c.html(dashboardPage(developer?.name ?? "Unknown developer", plays, statement));
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
