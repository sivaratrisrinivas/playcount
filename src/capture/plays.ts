// Turns one Claude Code tool event into Plays. Pure: no I/O, so it can be tested
// table-driven (seam 2) and runs on the Developer's machine inside the hook.
import { builtinModules } from "node:module";
import { isProjectName, type Play } from "../play.ts";

export type ToolEvent = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
  session_id: string;
};

// The PlayCount docs tool as Claude Code names it: server "playcount", tool "read_docs".
// Only our own tool counts; Context7 and WebFetch reads are out of scope for v1.
export const DOCS_TOOL = "mcp__playcount__read_docs";

const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

// The npm package an import specifier credits, or null when it is not a Project.
export function projectOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  if (builtins.has(spec) || builtins.has(parts[0]!)) return null;
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

// Comments become blank space of the same line count, so commented-out code is
// ignored. Strings are kept so a URL's "//" is not mistaken for a comment.
function withoutComments(text: string): string {
  return text.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, str: string | undefined) => str ?? match.replace(/[^\n]/g, ""),
  );
}

const STATEMENT =
  /\bimport\s+(?:type\s+)?([^"';]*?)\s+from\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+["']([^"']+)["']/g;

// The local names an import clause binds: default, namespace and named.
function boundNames(clause: string): string[] {
  const names: string[] = [];
  const defaultName = clause.match(/^([A-Za-z_$][\w$]*)/);
  if (defaultName) names.push(defaultName[1]!);
  const namespaceName = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceName) names.push(namespaceName[1]!);
  const named = clause.match(/\{([^}]*)\}/);
  for (const part of named?.[1]!.split(",") ?? []) {
    const local = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
    if (local) names.push(local);
  }
  return names;
}

// Project -> local names its imports bind (in source order), plus the code with
// every import and re-export statement blanked out, ready for counting uses.
function parse(source: string): { imports: Map<string, Set<string>>; body: string } {
  const imports = new Map<string, Set<string>>();
  const body = withoutComments(source).replace(STATEMENT, (match, clause?: string, from?: string, bare?: string, reexport?: string) => {
    const project = projectOf((from ?? bare ?? reexport)!);
    if (project) {
      const names = imports.get(project) ?? new Set<string>();
      if (clause) boundNames(clause.trim()).forEach((n) => names.add(n));
      imports.set(project, names);
    }
    return match.replace(/[^\n]/g, "");
  });
  return { imports, body };
}

const escapeDollar = (s: string) => s.replace(/[$]/g, "\\$");

function extensionOf(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

function failed(response: unknown): boolean {
  return typeof response === "object" && response !== null && (response as { isError?: unknown }).isError === true;
}

function docsPlays(event: ToolEvent, at: string): Play[] {
  const pkg = event.tool_input.package;
  if (typeof pkg !== "string" || failed(event.tool_response)) return [];
  const project = projectOf(pkg.trim());
  if (!project || !isProjectName(project)) return [];
  return [{ kind: "docs", project, session_id: event.session_id, at }];
}

export function playsFromToolEvent(event: ToolEvent, at: string): Play[] {
  if (event.tool_name === DOCS_TOOL) return docsPlays(event, at);
  if (event.tool_name !== "Write") return [];
  const content = event.tool_input.content;
  if (typeof content !== "string") return [];

  const { imports, body } = parse(content);
  const lines = body.split("\n");
  const file_ext = extensionOf(event.tool_input.file_path);

  return [...imports].map(([project, names]) => {
    const uses = names.size ? new RegExp(`(?<![\\w$])(${[...names].map(escapeDollar).join("|")})(?![\\w$])`) : null;
    const lines_written = uses ? lines.filter((l) => uses.test(l)).length : 0;
    return { kind: "import", project, lines_written, ...(file_ext && { file_ext }), session_id: event.session_id, at };
  });
}
