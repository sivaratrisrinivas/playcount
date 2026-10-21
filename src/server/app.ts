import { Hono } from "hono";
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

  app.get("/", (c) => {
    const developer = developers.byId(dashboardDeveloperId);
    const plays = developer ? ledger.playsOf(developer.id).reverse() : [];
    return c.html(dashboardPage(developer?.name ?? "Unknown developer", plays));
  });

  return app;
}
