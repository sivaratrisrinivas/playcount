import { Hono } from "hono";
import { html, raw } from "hono/html";
import { parsePlay, type Play } from "../play.ts";
import type { Developers } from "./developers.ts";
import type { Ledger } from "./ledger.ts";

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
    return c.html(dashboard(developer?.name ?? "Unknown developer", plays));
  });

  return app;
}

function dashboard(name: string, plays: Play[]) {
  const rows = plays.map(
    (p) => html`<tr>
      <td>${p.project}</td><td>${p.kind}</td><td>${p.lines_written ?? ""}</td><td>${p.file_ext ?? ""}</td>
      <td><time datetime="${p.at}">${p.at}</time></td>
    </tr>`,
  );
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PlayCount</title>
  <style>${raw(STYLE)}</style>
</head>
<body>
  <main>
    <h1>PlayCount</h1>
    <p>${name}'s Plays: <strong>${plays.length}</strong></p>
    ${plays.length
      ? html`<table>
      <thead><tr><th>Project</th><th>Kind</th><th>Lines written</th><th>File</th><th>When</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`
      : html`<p>No Plays yet. They appear here as your Agent writes code that imports npm packages.</p>`}
  </main>
</body>
</html>`;
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #e3e3e3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --muted: #999; --line: #333; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; }
  time { color: var(--muted); }
`;
