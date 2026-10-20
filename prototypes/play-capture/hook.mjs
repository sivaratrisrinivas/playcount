#!/usr/bin/env node
// PROTOTYPE: Claude Code PostToolUse hook that records plays. Never logs source code.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { builtinModules } from "node:module";

const LOG = resolve(process.env.PLAYCOUNT_LOG || ".playcount/plays.jsonl");
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const input = JSON.parse(await new Promise((r) => { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => r(s)); }));
const { tool_name: tool, tool_input: ti = {}, session_id } = input;

function log(play) {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), session_id, ...play }) + "\n");
}

function packageOf(spec) {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || builtins.has(spec) || builtins.has(spec.split("/")[0])) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function importsIn(text) {
  const found = new Map(); // package -> Set(local names)
  const add = (spec, names = []) => { const p = packageOf(spec); if (!p) return; if (!found.has(p)) found.set(p, new Set()); names.forEach((n) => n && found.get(p).add(n)); };
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1];
    const names = [];
    const def = clause.match(/^\s*([A-Za-z_$][\w$]*)/); if (def && !clause.trim().startsWith("{") && !clause.trim().startsWith("*")) names.push(def[1]);
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/); if (ns) names.push(ns[1]);
    const named = clause.match(/\{([^}]*)\}/); if (named) named[1].split(",").forEach((s) => { const n = s.trim().split(/\s+as\s+/).pop(); if (n) names.push(n.replace(/^type\s+/, "")); });
    add(m[2], names);
  }
  for (const m of text.matchAll(/import\s+["']([^"']+)["']/g)) add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) add(m[2], m[1].replace(/[{}]/g, "").split(",").map((s) => s.trim().split(":").pop().trim()));
  for (const m of text.matchAll(/(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) add(m[1]);
  for (const m of text.matchAll(/export\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g)) add(m[1]);
  return found;
}

if (["Write", "Edit", "MultiEdit"].includes(tool)) {
  const text = [ti.content, ti.new_string, ...(ti.edits || []).map((e) => e.new_string)].filter(Boolean).join("\n");
  const lines = text.split("\n");
  for (const [pkg, names] of importsIn(text)) {
    const re = names.size ? new RegExp(`\\b(${[...names].map((n) => n.replace(/\$/g, "\\$")).join("|")})\\b`) : null;
    const used = re ? lines.filter((l) => re.test(l) && !/^\s*import\b|require\(/.test(l)).length : 0;
    log({ kind: "import", project: pkg, lines_written: used, file_ext: (ti.file_path || "").split(".").pop() });
  }
} else if (tool === "mcp__playcount__read_docs") {
  log({ kind: "docs", project: ti.package, via: "playcount" });
} else if (tool?.startsWith("mcp__context7__")) {
  const lib = ti.libraryName || ti.context7CompatibleLibraryID || ti.libraryId;
  if (lib) log({ kind: "docs", project: lib, via: "context7" });
}
