// A Play, as it travels in the Play log. It never carries source code (ADR 0001).
// Shape agreed in the spec (issue #1), from the play-capture prototype.
export type Play = {
  kind: "import" | "docs";
  project: string;
  lines_written?: number;
  file_ext?: string;
  session_id: string;
  at: string;
};

const FIELDS = new Set(["kind", "project", "lines_written", "file_ext", "session_id", "at"]);
const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

// True when the name is one npm could publish, so it is safe to send as a Play's project.
export function isProjectName(name: string): boolean {
  return name.length <= 214 && NPM_NAME.test(name);
}

// Accepts exactly the Play-log fields and nothing else, so no source text can slip in.
export function parsePlay(value: unknown): Play | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !FIELDS.has(k))) return null;
  if (v.kind !== "import" && v.kind !== "docs") return null;
  if (typeof v.project !== "string" || !isProjectName(v.project)) return null;
  if (v.lines_written !== undefined && !(Number.isInteger(v.lines_written) && (v.lines_written as number) >= 0)) return null;
  if (v.file_ext !== undefined && !(typeof v.file_ext === "string" && /^[a-z0-9]{1,10}$/i.test(v.file_ext))) return null;
  if (typeof v.session_id !== "string" || v.session_id.length === 0 || v.session_id.length > 200) return null;
  if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
  return v as Play;
}
