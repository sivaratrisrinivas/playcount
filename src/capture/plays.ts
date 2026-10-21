// Turns one Claude Code tool event into Plays. Pure: no I/O, so it can be tested
// table-driven (seam 2) and runs on the Developer's machine inside the hook.
import { builtinModules } from "node:module";
import { isProjectName, type Play } from "../play.ts";

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
  const project = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  return isProjectName(project) ? project : null; // also drops computed `${...}` specifiers
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

const NAME = "[A-Za-z_$][\\w$]*";

// A require() or import() whose result is bound to names, e.g. `const x = require("p")`,
// `const { a } = await import("p")`, or TypeScript's `import x = require("p")`.
const BOUND_CALL = new RegExp(
  `\\b(?:const|let|var|import)\\s+(${NAME}|\\{[^{}]*\\})\\s*=\\s*(?:await\\s+)?(?:require|import)\\s*\\(\\s*(["'\`])([^"'\`]+)\\2\\s*\\)`,
  "g",
);
// Any other require() or import() of a package, used inline where it stands.
const INLINE_CALL = /(?<![\w$.])(?:require|import)\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g;

// The local names a destructuring pattern binds: `{ a, b: c, d = 1, ...e }` -> a, c, d, e.
function destructuredNames(pattern: string): string[] {
  return pattern
    .slice(1, -1)
    .split(",")
    .map((part) => part.split(":").pop()!.split("=")[0]!.replace("...", "").trim())
    .filter((name) => new RegExp(`^${NAME}$`).test(name));
}

type Imported = {
  names: Set<string>; // local names its imports bind
  declaredOn: Set<number>; // lines where an import statement or binding starts
  calledOn: Set<number>; // lines with an inline require() or import(), each a use
};

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length - 1;

// Project -> what the source imports from it, plus the code with every import,
// re-export and bound require blanked out, ready for counting uses line by line.
function parse(source: string): { imports: Map<string, Imported>; body: string } {
  const imports = new Map<string, Imported>();
  const importOf = (spec: string) => {
    const project = projectOf(spec);
    if (!project) return undefined;
    const entry = imports.get(project) ?? { names: new Set(), declaredOn: new Set(), calledOn: new Set() };
    imports.set(project, entry);
    return entry;
  };
  const blank = (match: string) => match.replace(/[^\n]/g, "");

  let body = withoutComments(source);
  body = body.replace(STATEMENT, (match, clause: string | undefined, from?: string, bare?: string, reexport?: string, offset?: number) => {
    const entry = importOf((from ?? bare ?? reexport)!);
    if (entry) {
      if (clause) boundNames(clause.trim()).forEach((n) => entry.names.add(n));
      entry.declaredOn.add(lineOf(body, offset!));
    }
    return blank(match);
  });
  body = body.replace(BOUND_CALL, (match, binding: string, _quote: string, spec: string, offset: number) => {
    const entry = importOf(spec);
    if (entry) {
      (binding.startsWith("{") ? destructuredNames(binding) : [binding]).forEach((n) => entry.names.add(n));
      entry.declaredOn.add(lineOf(body, offset));
    }
    return blank(match);
  });
  for (const call of body.matchAll(INLINE_CALL)) importOf(call[2]!)?.calledOn.add(lineOf(body, call.index));
  return { imports, body };
}

const escapeDollar = (s: string) => s.replace(/[$]/g, "\\$");

function extensionOf(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

// Lines of the new text that are not in the old text (each old line cancels one copy).
// Indentation is ignored, so re-indented lines are not new.
function addedLines(oldText: string, newText: string): Set<number> {
  const old = new Map<string, number>();
  for (const line of oldText.split("\n").map((l) => l.trim())) old.set(line, (old.get(line) ?? 0) + 1);
  const added = new Set<number>();
  newText.split("\n").map((l) => l.trim()).forEach((line, i) => {
    const left = old.get(line) ?? 0;
    if (left > 0) old.set(line, left - 1);
    else added.add(i);
  });
  return added;
}

// Project -> lines written against it, for the lines of `text` that `isNew` accepts.
// `known` adds the names the rest of the file already imports (for Edit and MultiEdit).
// A Project counts when a new line uses it or a new line imports it.
function linesWritten(text: string, isNew: (line: number) => boolean, known?: Map<string, Imported>): Map<string, number> {
  const { imports, body } = parse(text);
  const lines = body.split("\n");
  const counts = new Map<string, number>();
  for (const project of new Set([...(known?.keys() ?? []), ...imports.keys()])) {
    const here = imports.get(project);
    const names = [...(known?.get(project)?.names ?? []), ...(here?.names ?? [])];
    const uses = names.length ? new RegExp(`(?<![\\w$])(${names.map(escapeDollar).join("|")})(?![\\w$])`) : null;
    const count = lines.filter((l, i) => isNew(i) && (here?.calledOn.has(i) || uses?.test(l))).length;
    if (count > 0 || [...(here?.declaredOn ?? [])].some(isNew)) counts.set(project, count);
  }
  return counts;
}

type Edit = { old_string: string; new_string: string };

// Edits need the whole file to resolve imports at its top; the hook reads it locally.
export const needsFileContents = (event: ToolEvent) => event.tool_name === "Edit" || event.tool_name === "MultiEdit";

function editsOf(event: ToolEvent): Edit[] {
  const { tool_input: input } = event;
  const raw = event.tool_name === "Edit" ? [input] : input.edits;
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is Edit => typeof e?.old_string === "string" && typeof e?.new_string === "string");
}

// `fileContents` is the edited file as it is on disk after the tool ran; the hook
// reads it locally for Edit and MultiEdit so imports at the top of the file resolve.
export function playsFromToolEvent(event: ToolEvent, at: string, fileContents?: string): Play[] {
  const counts = new Map<string, number>();
  if (event.tool_name === "Write") {
    const content = event.tool_input.content;
    if (typeof content !== "string") return [];
    for (const [project, n] of linesWritten(content, () => true)) counts.set(project, n);
  } else if (needsFileContents(event)) {
    const known = fileContents === undefined ? undefined : parse(fileContents).imports;
    for (const { old_string, new_string } of editsOf(event)) {
      const added = addedLines(old_string, new_string);
      for (const [project, n] of linesWritten(new_string, (i) => added.has(i), known)) {
        counts.set(project, (counts.get(project) ?? 0) + n);
      }
    }
  }

  const file_ext = extensionOf(event.tool_input.file_path);
  return [...counts].map(([project, lines_written]) => ({
    kind: "import",
    project,
    lines_written,
    ...(file_ext && { file_ext }),
    session_id: event.session_id,
    at,
  }));
}
