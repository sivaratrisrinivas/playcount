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

// Reads Server-Sent Events from the live Play stream until `count` events arrive.
async function openStream(headers: Record<string, string> = {}, query = "") {
  const controller = new AbortController();
  const res = await fetch(`${server.url}/api/plays/stream${query}`, { headers, signal: controller.signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  async function next(count: number) {
    const events: { id: string; data: unknown }[] = [];
    while (events.length < count) {
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop()!;
      for (const block of blocks) {
        const id = block.match(/^id: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (id !== undefined && data !== undefined) events.push({ id, data: JSON.parse(data) });
      }
      if (events.length >= count) break;
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += value;
    }
    return events;
  }
  return { res, next, close: () => controller.abort() };
}

describe("Live Play stream", () => {
  it("pushes the dashboard Developer's Plays as they are ingested, numbered by count", async () => {
    const stream = await openStream();
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
    await postPlays({ plays: [play("zod"), play("express")] }, ada.key);
    const events = await stream.next(2);
    expect(events.map((e) => e.id)).toEqual(["1", "2"]);
    expect(events.map((e) => (e.data as { project: string }).project)).toEqual(["zod", "express"]);
    stream.close();
  });

  it("carries only that Developer's Plays", async () => {
    const stream = await openStream();
    await postPlays({ plays: [play("left-pad")] }, bob.key);
    await postPlays({ plays: [play("zod")] }, ada.key);
    const [first] = await stream.next(1);
    expect(first).toEqual({ id: "1", data: expect.objectContaining({ project: "zod" }) });
    stream.close();
  });

  it("starts after the Plays the page already shows", async () => {
    await postPlays({ plays: [play("zod")] }, ada.key);
    const stream = await openStream({}, "?since=1");
    await postPlays({ plays: [play("express")] }, ada.key);
    expect(await stream.next(1)).toEqual([{ id: "2", data: expect.objectContaining({ project: "express" }) }]);
    stream.close();
  });

  it("replays the Plays missed while disconnected, so the count is not lost", async () => {
    await postPlays({ plays: [play("zod"), play("express"), play("hono")] }, ada.key);
    const stream = await openStream({ "last-event-id": "1" }, "?since=0");
    const events = await stream.next(2);
    expect(events.map((e) => e.id)).toEqual(["2", "3"]);
    expect(events.map((e) => (e.data as { project: string }).project)).toEqual(["express", "hono"]);
    stream.close();
  });

  it("stops pushing to a stream once its connection drops", async () => {
    const stream = await openStream();
    stream.close();
    await new Promise((r) => setTimeout(r, 20));
    const res = await postPlays({ plays: [play("zod")] }, ada.key);
    expect(res.status).toBe(202);
    expect(ledger.playsOf(ada.id)).toHaveLength(1);
  });
});

describe("Live dashboard", () => {
  it("subscribes to the live Play stream from the count it rendered", async () => {
    await postPlays({ plays: [play("zod"), play("express")] }, ada.key);
    const html = await (await fetch(`${server.url}/`)).text();
    expect(html).toContain('data-count="2"');
    expect(html).toContain("/api/plays/stream");
  });
});
