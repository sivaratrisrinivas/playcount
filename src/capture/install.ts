// Installs PlayCount capture for one Developer. The dashboard's install command pipes this
// file into Node, so it must stand alone (no relative imports):
//
//   curl -fsSL <service>/install.ts | node --input-type=module-typescript - <service> <PlayCount key>
//
// It downloads the hook and docs tool into ~/.playcount/capture, adds the hook, the service
// URL and the key to user-level Claude Code settings (so capture works in every repo without
// trusting each project), and registers the docs tool as a user-scoped MCP server.
// Running it again, e.g. after rotating the key, updates the same entries.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Must match the server's capture files: the hook, the docs tool and what they import.
const FILES = ["src/play.ts", "src/capture/hook.ts", "src/capture/plays.ts", "src/capture/queue.ts", "src/capture/docs-server.ts"];
const DOCS_TOOL = "mcp__playcount__read_docs";
const MATCHER = `Write|Edit|MultiEdit|${DOCS_TOOL}`;
// Recognises a PlayCount hook command from this installer or the README's manual setup.
const PLAYCOUNT_HOOK = /playcount.*capture[/\\]hook\.ts/i;

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };
type Settings = {
  env?: Record<string, string>;
  permissions?: { allow?: string[] };
  hooks?: { PostToolUse?: HookEntry[] };
  [key: string]: unknown;
};

function fail(message: string): never {
  console.error(`PlayCount install failed: ${message}`);
  process.exit(1);
}

const [url = "", key = ""] = process.argv.slice(2).map((a) => a.trim());
if (!/^https?:\/\/[^\s/]+/.test(url)) fail("the first argument must be the PlayCount service URL, e.g. https://playcount.onrender.com");
if (!/^pk_[\w-]+$/.test(key)) fail("the second argument must be your PlayCount key (it starts with pk_). Copy the command from your dashboard.");
const service = url.replace(/\/$/, "");

const captureDir = join(homedir(), ".playcount", "capture");
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const settingsPath = join(configDir, "settings.json");

// Read settings before downloading anything, so unreadable settings stop the install untouched.
async function readSettings(): Promise<Settings> {
  const text = await readFile(settingsPath, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "{}";
    fail(`could not read ${settingsPath}: ${err.message}`);
  });
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Settings;
  } catch {}
  fail(`${settingsPath} is not a JSON object. Fix it and run the command again.`);
}

function withPlayCount(settings: Settings, hookCommand: string): Settings {
  const allow = settings.permissions?.allow ?? [];
  // Earlier PlayCount hooks are removed, so a rerun or a manual setup leaves exactly one.
  const others = (settings.hooks?.PostToolUse ?? [])
    .map((entry) => ({ ...entry, hooks: entry.hooks?.filter((h) => !PLAYCOUNT_HOOK.test(h.command ?? "")) }))
    .filter((entry) => entry.hooks?.length);
  return {
    ...settings,
    env: { ...settings.env, PLAYCOUNT_URL: service, PLAYCOUNT_KEY: key },
    permissions: { ...settings.permissions, allow: allow.includes(DOCS_TOOL) ? allow : [...allow, DOCS_TOOL] },
    hooks: {
      ...settings.hooks,
      PostToolUse: [...others, { matcher: MATCHER, hooks: [{ type: "command", command: hookCommand }] }],
    },
  };
}

async function download(file: string) {
  const res = await fetch(`${service}/capture/${file}`, { signal: AbortSignal.timeout(30_000) }).catch((err: Error) =>
    fail(`could not reach ${service}: ${err.message}`),
  );
  if (!res.ok) fail(`${service} answered ${res.status} for ${file}`);
  const path = join(captureDir, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await res.text());
}

const settings = await readSettings();

for (const file of FILES) await download(file);
await writeFile(join(captureDir, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n");

const hook = join(captureDir, "src", "capture", "hook.ts");
const docsServer = join(captureDir, "src", "capture", "docs-server.ts");
await mkdir(configDir, { recursive: true });
const next = `${settingsPath}.playcount-${process.pid}`;
await writeFile(next, JSON.stringify(withPlayCount(settings, `node "${hook}"`), null, 2) + "\n");
await rename(next, settingsPath);
console.log(`Added the PlayCount hook to ${settingsPath}`);

// The docs tool is registered through the Claude Code CLI, which owns where MCP servers live.
const mcpAdd = ["mcp", "add", "--scope", "user", "playcount", "--", "node", docsServer];
spawnSync("claude", ["mcp", "remove", "--scope", "user", "playcount"], { stdio: "ignore" });
const added = spawnSync("claude", mcpAdd, { stdio: "ignore" });
if (added.status === 0) console.log("Added the PlayCount docs tool (read_docs) to Claude Code.");
else console.log(`Could not run the claude CLI. Add the docs tool yourself:\n  claude ${mcpAdd.join(" ")}`);

console.log(`PlayCount is set up. Start a new Claude Code session and your Plays will appear at ${service}`);
