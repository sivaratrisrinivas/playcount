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
});
