// Turns one Claude Code tool event into Plays. Pure: no I/O, so it can be tested
// table-driven (seam 2) and runs on the Developer's machine inside the hook.
import { builtinModules } from "node:module";
import type { Play } from "../play.ts";

export type ToolEvent = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id: string;
};

const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

// The npm package an import specifier credits, or null when it is not a Project.
function projectOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  if (builtins.has(spec) || builtins.has(parts[0]!)) return null;
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

// Project -> local names its imports bind, in order of first appearance.
function importsIn(text: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (spec: string, names: string[] = []) => {
    const project = projectOf(spec);
    if (!project) return;
    const set = found.get(project) ?? new Set<string>();
    names.filter(Boolean).forEach((n) => set.add(n));
    found.set(project, set);
  };

  for (const m of text.matchAll(/import\s+(?:type\s+)?([^"';]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1]!.trim();
    const names: string[] = [];
    const def = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (def) names.push(def[1]!);
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) names.push(ns[1]!);
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1]!.split(",")) {
        const local = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
        if (local) names.push(local);
      }
    }
    add(m[2]!, names);
  }
  for (const m of text.matchAll(/import\s+["']([^"']+)["']/g)) add(m[1]!);
  return found;
}

const escape = (s: string) => s.replace(/[$]/g, "\\$");

function extensionOf(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

export function playsFromToolEvent(event: ToolEvent, at: string): Play[] {
  if (event.tool_name !== "Write") return [];
  const content = event.tool_input.content;
  if (typeof content !== "string") return [];

  const lines = content.split("\n").filter((l) => !/^\s*import\b/.test(l));
  const file_ext = extensionOf(event.tool_input.file_path);

  return [...importsIn(content)].map(([project, names]) => {
    const uses = names.size ? new RegExp(`(?<![\\w$])(${[...names].map(escape).join("|")})(?![\\w$])`) : null;
    const lines_written = uses ? lines.filter((l) => uses.test(l)).length : 0;
    return { kind: "import", project, lines_written, ...(file_ext && { file_ext }), session_id: event.session_id, at };
  });
}
