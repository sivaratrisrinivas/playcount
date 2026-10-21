import { spawn } from "node:child_process";
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

const readDocsEvent = {
  session_id: "s2",
  hook_event_name: "PostToolUse",
  tool_name: "mcp__playcount__read_docs",
  tool_input: { package: "zod" },
  tool_response: [{ type: "text", text: "# Zod" }],
};

function runHook(env: Record<string, string>, toolEvent: object = event): Promise<{ code: number | null; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env }, stdio: ["pipe", "ignore", "ignore"] });
    child.on("close", (code) => resolve({ code, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(toolEvent));
  });
}

let server: RunningServer;
let ledger: Ledger;

beforeEach(async () => {
  ledger = inMemoryLedger();
  server = await startServer({ ledger, developers: inMemoryDevelopers([dev]), dashboardDeveloperId: dev.id, port: 0 });
});
afterEach(() => server.close());

it("sends the Plays from a Write to PlayCount", async () => {
  const { code } = await runHook({ PLAYCOUNT_URL: server.url, PLAYCOUNT_KEY: dev.key });
  expect(code).toBe(0);
  expect(ledger.playsOf(dev.id)).toEqual([
    expect.objectContaining({ kind: "import", project: "zod", lines_written: 1, file_ext: "ts", session_id: "s1" }),
  ]);
});

it("sends a docs Play when the Agent reads docs through the PlayCount docs tool, and it shows on the dashboard", async () => {
  const { code } = await runHook({ PLAYCOUNT_URL: server.url, PLAYCOUNT_KEY: dev.key }, readDocsEvent);
  expect(code).toBe(0);
  expect(ledger.playsOf(dev.id)).toEqual([expect.objectContaining({ kind: "docs", project: "zod", session_id: "s2" })]);
  const page = await (await fetch(server.url)).text();
  expect(page).toMatch(/<td>zod<\/td><td>docs<\/td>/);
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
