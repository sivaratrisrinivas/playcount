import type { Play } from "../play.ts";

export type StatementLine = { project: string; import_plays: number; docs_plays: number; lines_written: number };
// A period is a calendar month in UTC, written "YYYY-MM".
export type Statement = { period: string; projects: StatementLine[] };

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPeriod(value: string): boolean {
  return PERIOD.test(value);
}

export function periodOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

// Per-Project totals of one Developer's Plays in one period, most Plays first.
export function statementOf(plays: Play[], period: string): Statement {
  const lines = new Map<string, StatementLine>();
  for (const p of plays) {
    if (periodOf(new Date(p.at)) !== period) continue;
    const line = lines.get(p.project) ?? { project: p.project, import_plays: 0, docs_plays: 0, lines_written: 0 };
    if (p.kind === "import") line.import_plays++;
    else line.docs_plays++;
    line.lines_written += p.lines_written ?? 0;
    lines.set(p.project, line);
  }
  const total = (l: StatementLine) => l.import_plays + l.docs_plays;
  const projects = [...lines.values()].sort((a, b) => total(b) - total(a) || a.project.localeCompare(b.project));
  return { period, projects };
}
