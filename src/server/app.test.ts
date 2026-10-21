import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "./server.ts";
import { inMemoryLedger, type Ledger } from "./ledger.ts";
import { inMemoryDevelopers } from "./developers.ts";

const ada = { id: "dev_ada", name: "Ada", key: "pk_ada" };
const bob = { id: "dev_bob", name: "Bob", key: "pk_bob" };

const play = (project: string, extra: Record<string, unknown> = {}) => ({
  kind: "import",
  project,
  lines_written: 3,
  file_ext: "ts",
  session_id: "s1",
  at: "2026-10-21T12:00:00.000Z",
  ...extra,
});

let server: RunningServer;
let ledger: Ledger;

beforeEach(async () => {
  ledger = inMemoryLedger();
  server = await startServer({
    ledger,
    developers: inMemoryDevelopers([ada, bob]),
    dashboardDeveloperId: ada.id,
    clock: () => new Date("2026-10-21T18:00:00.000Z"),
    port: 0,
  });
});

afterEach(() => server.close());

function postPlays(body: unknown, key?: string) {
  return fetch(`${server.url}/api/plays`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) },
    body: JSON.stringify(body),
  });
}

describe("Play ingestion", () => {
  it("records a batch of Plays against the key's Developer", async () => {
    const res = await postPlays({ plays: [play("zod"), play("express")] }, ada.key);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ recorded: 2 });
    expect(ledger.playsOf(ada.id).map((p) => p.project)).toEqual(["zod", "express"]);
    expect(ledger.playsOf(bob.id)).toEqual([]);
  });

  it("rejects a missing PlayCount key", async () => {
    const res = await postPlays({ plays: [play("zod")] });
    expect(res.status).toBe(401);
    expect(ledger.playsOf(ada.id)).toEqual([]);
  });

  it("rejects a wrong PlayCount key", async () => {
    const res = await postPlays({ plays: [play("zod")] }, "pk_nobody");
    expect(res.status).toBe(401);
  });

  it.each([
    { name: "a body that is not a batch", body: [play("zod")] },
    { name: "an unknown kind of Play", body: { plays: [play("zod", { kind: "install" })] } },
    { name: "a project that is not an npm name", body: { plays: [play("<script>")] } },
    { name: "a field outside the Play log, such as source text (ADR 0001)", body: { plays: [play("zod", { content: "const x = 1" })] } },
  ])("rejects $name and records nothing", async ({ body }) => {
    const res = await postPlays(body, ada.key);
    expect(res.status).toBe(400);
    expect(ledger.playsOf(ada.id)).toEqual([]);
  });
});

function getStatement(query: string, key?: string) {
  return fetch(`${server.url}/api/statement${query}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

describe("Period statement", () => {
  it("totals each Project's import Plays, docs Plays and lines written for the period", async () => {
    await postPlays(
      {
        plays: [
          play("zod", { lines_written: 3 }),
          play("zod", { lines_written: 5 }),
          { kind: "docs", project: "zod", session_id: "s1", at: "2026-10-21T12:05:00.000Z" },
          play("@hono/node-server", { lines_written: 2 }),
        ],
      },
      ada.key,
    );
    const res = await getStatement("?period=2026-10", ada.key);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      period: "2026-10",
      projects: [
        { project: "zod", import_plays: 2, docs_plays: 1, lines_written: 8 },
        { project: "@hono/node-server", import_plays: 1, docs_plays: 0, lines_written: 2 },
      ],
    });
  });

  it("counts only Plays made in that period (calendar month, UTC)", async () => {
    await postPlays(
      {
        plays: [
          play("zod", { at: "2026-09-30T23:59:59.999Z" }),
          play("express", { at: "2026-10-01T00:00:00.000Z" }),
          play("lodash", { at: "2026-11-01T00:00:00.000Z" }),
        ],
      },
      ada.key,
    );
    const body = await (await getStatement("?period=2026-10", ada.key)).json();
    expect(body.projects.map((p: { project: string }) => p.project)).toEqual(["express"]);
  });

  it("defaults to the current period", async () => {
    await postPlays({ plays: [play("zod"), play("express", { at: "2026-09-15T00:00:00.000Z" })] }, ada.key);
    const body = await (await getStatement("", ada.key)).json();
    expect(body.period).toBe("2026-10");
    expect(body.projects.map((p: { project: string }) => p.project)).toEqual(["zod"]);
  });

  it("includes only the Developer's own Plays", async () => {
    await postPlays({ plays: [play("zod")] }, ada.key);
    await postPlays({ plays: [play("left-pad")] }, bob.key);
    const body = await (await getStatement("?period=2026-10", bob.key)).json();
    expect(body.projects.map((p: { project: string }) => p.project)).toEqual(["left-pad"]);
  });

  it("is empty for a period with no Plays", async () => {
    const body = await (await getStatement("?period=2026-08", ada.key)).json();
    expect(body).toEqual({ period: "2026-08", projects: [] });
  });

  it("rejects a missing or wrong PlayCount key", async () => {
    expect((await getStatement("?period=2026-10")).status).toBe(401);
    expect((await getStatement("?period=2026-10", "pk_nobody")).status).toBe(401);
  });

  it.each(["2026-13", "2026-1", "october", "2026-10-01"])("rejects the period %s", async (period) => {
    expect((await getStatement(`?period=${period}`, ada.key)).status).toBe(400);
  });
});

describe("Health check", () => {
  it("reports the service is up", async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("Dashboard", () => {
  it("lists the Developer's Plays", async () => {
    await postPlays({ plays: [play("zod", { lines_written: 4, file_ext: "tsx" })] }, ada.key);
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("zod");
    expect(html).toContain(">4<");
    expect(html).toContain("tsx");
  });

  it("shows only that Developer's Plays", async () => {
    await postPlays({ plays: [play("left-pad")] }, bob.key);
    const html = await (await fetch(`${server.url}/`)).text();
    expect(html).not.toContain("left-pad");
  });

  it("shows the current period's statement in a sortable AG Grid table", async () => {
    await postPlays({ plays: [play("zod", { lines_written: 7 }), play("express", { at: "2026-09-01T00:00:00.000Z" })] }, ada.key);
    const html = await (await fetch(`${server.url}/`)).text();
    const statement = statementIn(html);
    expect(statement).toEqual({
      period: "2026-10",
      projects: [{ project: "zod", import_plays: 1, docs_plays: 0, lines_written: 7 }],
    });
    expect(html).toContain('src="/vendor/ag-grid-community.min.js"');
    expect(html).toContain("sortable: true");
  });

  it("serves AG Grid itself, so the dashboard needs no CDN", async () => {
    const res = await fetch(`${server.url}/vendor/ag-grid-community.min.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("createGrid");
  });
});

// The dashboard embeds the statement as JSON for the grid to render.
function statementIn(html: string) {
  const json = html.match(/<script type="application\/json" id="statement">(.*?)<\/script>/s)?.[1];
  return json ? JSON.parse(json) : undefined;
}
