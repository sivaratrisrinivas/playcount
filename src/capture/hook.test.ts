import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startServer, type RunningServer } from "../server/server.ts";
import { inMemoryLedger, type Ledger } from "../server/ledger.ts";
import { inMemoryDevelopers } from "../server/developers.ts";

const HOOK = fileURLToPath(new URL("./hook.ts", import.meta.url));
const dev = { id: "dev_ada", name: "Ada", key: "pk_ada" };

const event = {
  session_id: "s1",
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: "/repo/src/a.ts", content: 'import { z } from "zod";\nexport const s = z.string();\n' },
  tool_response: { success: true },
};

let server: RunningServer;
let ledger: Ledger;
let queueDir: string;

function runHook(env: Record<string, string> = { PLAYCOUNT_URL: server.url, PLAYCOUNT_KEY: dev.key }, input: unknown = event): Promise<{ code: number | null; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, PLAYCOUNT_QUEUE_DIR: queueDir, ...env },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("close", (code) => resolve({ code, ms: Date.now() - started }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

beforeEach(async () => {
  ledger = inMemoryLedger();
  server = await startServer({ ledger, developers: inMemoryDevelopers([dev]), dashboardDeveloperId: dev.id, port: 0 });
  queueDir = mkdtempSync(join(tmpdir(), "playcount-queue-"));
});
afterEach(async () => {
  await server.close();
  rmSync(queueDir, { recursive: true, force: true });
});

it("sends the Plays from a Write to PlayCount", async () => {
  const { code } = await runHook();
  expect(code).toBe(0);
  expect(ledger.playsOf(dev.id)).toEqual([
    expect.objectContaining({ kind: "import", project: "zod", lines_written: 1, file_ext: "ts", session_id: "s1" }),
  ]);
});

it("never fails the Agent's tool call when PlayCount is unreachable", async () => {
  const { code, ms } = await runHook({ PLAYCOUNT_URL: "http://127.0.0.1:9", PLAYCOUNT_KEY: dev.key });
  expect(code).toBe(0);
  expect(ms).toBeLessThan(5000);
});

it("does nothing without a PlayCount key", async () => {
  const { code } = await runHook({ PLAYCOUNT_URL: server.url, PLAYCOUNT_KEY: "" });
  expect(code).toBe(0);
  expect(ledger.playsOf(dev.id)).toEqual([]);
});

it("reads the edited file locally to credit an import already at its top", async () => {
  const file = join(queueDir, "form.ts");
  writeFileSync(file, 'import { z } from "zod";\nexport const s = z.string().min(1);\n');
  const editEvent = {
    ...event,
    tool_name: "Edit",
    tool_input: { file_path: file, old_string: "export const s = z.string();", new_string: "export const s = z.string().min(1);" },
  };
  expect((await runHook(undefined, editEvent)).code).toBe(0);
  expect(ledger.playsOf(dev.id)).toEqual([expect.objectContaining({ project: "zod", lines_written: 1, file_ext: "ts" })]);
});

it("queues Plays locally when PlayCount is unreachable and sends them on a later run", async () => {
  expect((await runHook({ PLAYCOUNT_URL: "http://127.0.0.1:9", PLAYCOUNT_KEY: dev.key })).code).toBe(0);
  expect(readdirSync(queueDir)).not.toEqual([]);

  const later = { ...event, session_id: "s2" };
  expect((await runHook(undefined, later)).code).toBe(0);
  expect(ledger.playsOf(dev.id).map((p) => p.session_id)).toEqual(["s1", "s2"]);
  expect(readdirSync(queueDir)).toEqual([]);
});

it("queues Plays when PlayCount errors, and never fails the tool call", async () => {
  const failing = await startServer({
    ledger: { recordPlays: () => { throw new Error("boom"); }, playsOf: () => [] },
    developers: inMemoryDevelopers([dev]),
    dashboardDeveloperId: dev.id,
    port: 0,
  });
  try {
    expect((await runHook({ PLAYCOUNT_URL: failing.url, PLAYCOUNT_KEY: dev.key })).code).toBe(0);
  } finally {
    await failing.close();
  }
  await runHook(undefined, { ...event, tool_name: "Bash", tool_input: { command: "ls" } });
  expect(ledger.playsOf(dev.id)).toEqual([expect.objectContaining({ project: "zod", session_id: "s1" })]);
});

it("never fails the Agent's tool call on input it cannot read", async () => {
  const { code } = await runHook(undefined, "not json");
  expect(code).toBe(0);
});

it("sends good queued Plays even when the queue holds one PlayCount would reject", async () => {
  const bad = { ...event, kind: "import", project: "Not A Package", session_id: "s0", at: new Date().toISOString() };
  writeFileSync(join(queueDir, "queue.jsonl"), `${JSON.stringify(bad)}\ntorn{\n`);
  await runHook();
  expect(ledger.playsOf(dev.id)).toEqual([expect.objectContaining({ project: "zod", session_id: "s1" })]);
  expect(readdirSync(queueDir)).toEqual([]);
});

it("picks up a batch abandoned by a killed hook, but not one another hook has just taken", async () => {
  const queued = JSON.stringify({ kind: "import", project: "ky", session_id: "s0", at: new Date().toISOString() });
  const taken = join(queueDir, "taken-other-hook");
  writeFileSync(taken, queued + "\n");
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(taken, old, old);
  await runHook();
  expect(ledger.playsOf(dev.id).map((p) => p.project)).toEqual(["ky", "zod"]);

  const fresh = join(queueDir, "taken-just-now");
  writeFileSync(fresh, queued + "\n");
  await runHook();
  expect(ledger.playsOf(dev.id).map((p) => p.project)).toEqual(["ky", "zod", "zod"]);
});
