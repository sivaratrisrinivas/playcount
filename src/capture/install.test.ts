import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installCommand } from "../server/app.ts";
import { inMemoryDevelopers, type Developer, type Developers } from "../server/developers.ts";
import { inMemoryLedger, type Ledger } from "../server/ledger.ts";
import { startServer, type RunningServer } from "../server/server.ts";

let server: RunningServer;
let ledger: Ledger;
let developers: Developers;
let developer: Developer;
let home: string;
let settingsPath: string;
let claudeLog: string;

beforeEach(async () => {
  ledger = inMemoryLedger();
  developers = inMemoryDevelopers([]);
  developer = developers.signIn({ id: 101, login: "ada", name: "Ada" });
  server = await startServer({ ledger, developers, port: 0 });

  home = mkdtempSync(join(tmpdir(), "playcount-home-"));
  settingsPath = join(home, ".claude", "settings.json");
  // A stand-in for the Claude Code CLI that records how the installer called it.
  claudeLog = join(home, "claude-calls.log");
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin", "claude"), `#!/bin/sh\necho "$@" >> "${claudeLog}"\n`);
  chmodSync(join(home, "bin", "claude"), 0o755);
});

afterEach(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

const env = () => ({ ...process.env, HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: "" });

// Runs the install command exactly as the dashboard shows it, in a shell.
function install(key = developer.key): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", installCommand(server.url, key)], { env: env(), cwd: home }, (err, stdout, stderr) =>
      resolve({ code: err ? Number(err.code ?? 1) : 0, output: stdout + stderr }),
    );
  });
}

type Settings = {
  env?: Record<string, string>;
  permissions?: { allow?: string[] };
  hooks?: { PostToolUse?: { matcher: string; hooks: { type: string; command: string }[] }[] };
  [k: string]: unknown;
};
const settings = (): Settings => JSON.parse(readFileSync(settingsPath, "utf8"));
const playCountHooks = () =>
  (settings().hooks?.PostToolUse ?? []).filter((entry) => entry.hooks.some((h) => h.command.includes("hook.ts")));

// Runs the installed hook the way Claude Code would: the settings' command, with the settings' env.
function runInstalledHook(cwd: string, input: unknown): Promise<number | null> {
  const [entry] = playCountHooks();
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", entry.hooks[0].command], {
      env: { ...env(), ...settings().env },
      cwd,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("close", resolve);
    child.stdin.end(JSON.stringify(input));
  });
}

it("installs the hook into user-level Claude Code settings with the service URL and PlayCount key", async () => {
  const { code, output } = await install();
  expect(code, output).toBe(0);
  const s = settings();
  expect(s.env).toEqual({ PLAYCOUNT_URL: server.url, PLAYCOUNT_KEY: developer.key });
  expect(s.permissions?.allow).toContain("mcp__playcount__read_docs");
  expect(playCountHooks()).toEqual([
    {
      matcher: "Write|Edit|MultiEdit|mcp__playcount__read_docs",
      hooks: [{ type: "command", command: `node "${join(home, ".playcount", "capture", "src", "capture", "hook.ts")}"` }],
    },
  ]);
});

it("installs the docs tool as a user-scoped MCP server named playcount", async () => {
  await install();
  const docsServer = join(home, ".playcount", "capture", "src", "capture", "docs-server.ts");
  expect(existsSync(docsServer)).toBe(true);
  expect(readFileSync(claudeLog, "utf8")).toContain(`mcp add --scope user playcount -- node ${docsServer}`);
});

it("keeps the Developer's other settings", async () => {
  mkdirSync(join(home, ".claude"));
  const mine = {
    model: "opus",
    env: { EDITOR: "vim" },
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
  };
  writeFileSync(settingsPath, JSON.stringify(mine));
  await install();
  const s = settings();
  expect(s.model).toBe("opus");
  expect(s.env?.EDITOR).toBe("vim");
  expect(s.permissions?.allow).toEqual(["Bash(ls:*)", "mcp__playcount__read_docs"]);
  expect(s.hooks?.PostToolUse?.[0]).toEqual(mine.hooks.PostToolUse[0]);
});

it("can run again after a key rotation, replacing the key without adding a second hook", async () => {
  await install();
  const rotated = developers.rotateKey(developer.id)!.key;
  const { code } = await install(rotated);
  expect(code).toBe(0);
  expect(settings().env?.PLAYCOUNT_KEY).toBe(rotated);
  expect(playCountHooks()).toHaveLength(1);
  expect(settings().permissions?.allow?.filter((p) => p === "mcp__playcount__read_docs")).toHaveLength(1);
});

it("leaves settings it cannot read untouched and says so", async () => {
  mkdirSync(join(home, ".claude"));
  writeFileSync(settingsPath, "{ not json");
  const { code, output } = await install();
  expect(code).not.toBe(0);
  expect(output).toContain(settingsPath);
  expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
});

it("refuses a key that is not a PlayCount key", async () => {
  const { code, output } = await install("not-a-key");
  expect(code).not.toBe(0);
  expect(output).toMatch(/PlayCount key/);
  expect(existsSync(settingsPath)).toBe(false);
});

it("after install, Plays from any repo reach that Developer's dashboard", async () => {
  await install();
  for (const repo of ["repo-one", "repo-two"]) {
    const dir = join(home, repo);
    mkdirSync(dir);
    const code = await runInstalledHook(dir, {
      session_id: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(dir, "a.ts"), content: 'import { z } from "zod";\nexport const s = z.string();\n' },
      tool_response: { success: true },
    });
    expect(code).toBe(0);
  }
  expect(ledger.playsOf(developer.id).map((p) => [p.project, p.session_id])).toEqual([
    ["zod", "repo-one"],
    ["zod", "repo-two"],
  ]);
});
