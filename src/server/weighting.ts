// Weighting: the share of a Developer's Budget each Project gets for one period. Claude proposes
// it from the period's statement, the Developer may adjust and approve it, and a proposal nobody
// approves auto-approves 7 days later. Once approved it is locked for that period.
import type { Ledger } from "./ledger.ts";
import { statementOf, type Statement, type StatementLine } from "./statement.ts";
import type { Weigher, Weight } from "./weigher.ts";

// A share is a percentage with at most two decimals; a Weighting's shares sum to exactly 100.
export type Share = { project: string; share: number; reason: string };

export type Weighting = {
  period: string;
  status: "proposed" | "approved";
  // "play counts" when Claude could not be reached or gave an unusable answer.
  proposed_by: "claude" | "play counts";
  proposed_at: string;
  auto_approves_at: string;
  adjusted: boolean;
  approved_at?: string;
  approved_by?: "developer" | "auto";
  shares: Share[];
};

export const AUTO_APPROVE_AFTER_MS = 7 * 24 * 3600 * 1000;
const WHOLE = 10_000; // 100%, in hundredths of a percent
const MAX_REASON = 160;

export type WeightingResult =
  | { ok: true; weighting: Weighting }
  | { ok: false; status: 400 | 404 | 409 | 422; error: string };

const fail = (status: 400 | 404 | 409 | 422, error: string): WeightingResult => ({ ok: false, status, error });
const done = (weighting: Weighting): WeightingResult => ({ ok: true, weighting });

const byShare = (a: Share, b: Share) => b.share - a.share || a.project.localeCompare(b.project);

// Splits 100% in proportion to the weights, in hundredths, handing leftover hundredths to the
// largest remainders so the shares always sum to exactly 100.
function toShares(weights: Weight[]): Share[] {
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  const exact = weights.map((w) => (total > 0 ? (w.weight / total) * WHOLE : WHOLE / weights.length));
  const parts = exact.map(Math.floor);
  let left = WHOLE - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, rem: x - parts[i] })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left-- <= 0) break;
    parts[i]++;
  }
  return weights.map((w, i) => ({ project: w.project, share: parts[i] / 100, reason: oneLine(w.reason) })).sort(byShare);
}

const oneLine = (reason: string) => {
  const line = reason.replace(/\s+/g, " ").trim();
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
};

// Claude's weights are usable only if they name every played Project once, with a reason.
function usable(weights: Weight[], lines: StatementLine[]): Weight[] | undefined {
  const played = new Set(lines.map((l) => l.project));
  const kept = weights.filter((w) => played.has(w.project));
  const ok =
    new Set(kept.map((w) => w.project)).size === played.size &&
    kept.length === played.size &&
    kept.every((w) => Number.isFinite(w.weight) && w.weight >= 0 && oneLine(w.reason) !== "");
  return ok ? kept : undefined;
}

const byPlays = (lines: StatementLine[]): Weight[] =>
  lines.map((l) => ({
    project: l.project,
    weight: l.import_plays + l.docs_plays + l.lines_written,
    reason: `${l.import_plays} import Play${l.import_plays === 1 ? "" : "s"}, ${l.docs_plays} docs Play${l.docs_plays === 1 ? "" : "s"}, ${l.lines_written} lines written`,
  }));

// Checks an adjustment: one share per played Project, each a non-negative percentage with at
// most two decimals, summing to exactly 100%.
function parseAdjustment(value: unknown, current: Share[]): Map<string, number> | string {
  if (!Array.isArray(value)) return "expected { shares: [{ project, share }] }";
  const shares = new Map<string, number>();
  for (const item of value) {
    const { project, share } = (item ?? {}) as { project?: unknown; share?: unknown };
    if (typeof project !== "string" || typeof share !== "number" || !Number.isFinite(share)) {
      return "each share needs a project and a numeric share";
    }
    if (share < 0) return `${project}'s share is negative`;
    if (Math.abs(share * 100 - Math.round(share * 100)) > 1e-6) return `${project}'s share has more than two decimals`;
    if (shares.has(project)) return `${project} is listed twice`;
    shares.set(project, Math.round(share * 100));
  }
  const played = current.map((s) => s.project);
  const missing = played.filter((p) => !shares.has(p));
  if (missing.length) return `every played Project needs a share; missing ${missing.join(", ")}`;
  const extra = [...shares.keys()].filter((p) => !played.includes(p));
  if (extra.length) return `${extra.join(", ")} ${extra.length === 1 ? "was" : "were"} not played this period`;
  const sum = [...shares.values()].reduce((a, b) => a + b, 0);
  if (sum !== WHOLE) return `shares must sum to 100%, not ${sum / 100}%`;
  return shares;
}

export type Weightings = ReturnType<typeof weightings>;

export function weightings({ ledger, weigher, clock }: { ledger: Ledger; weigher?: Weigher; clock: () => Date }) {
  // The Developer's Weighting for the period, auto-approving it first if 7 days have passed.
  function current(developerId: string, period: string): Weighting | undefined {
    const weighting = ledger.weightingOf(developerId, period);
    if (weighting?.status !== "proposed" || clock().getTime() < Date.parse(weighting.auto_approves_at)) return weighting;
    const approved: Weighting = { ...weighting, status: "approved", approved_by: "auto", approved_at: weighting.auto_approves_at };
    ledger.recordWeighting(developerId, approved);
    return approved;
  }

  async function claudeWeights(statement: Statement): Promise<Weight[] | undefined> {
    if (!weigher) return undefined;
    try {
      return usable(await weigher.weigh(statement), statement.projects);
    } catch (err) {
      console.warn(`Weigher failed, weighting by Plays instead: ${(err as Error).message}`);
      return undefined;
    }
  }

  return {
    current,

    async propose(developerId: string, period: string): Promise<WeightingResult> {
      if (current(developerId, period)?.status === "approved") return fail(409, "this period's Weighting is approved and locked");
      const statement = statementOf(ledger.playsOf(developerId), period);
      if (!statement.projects.length) return fail(422, "no Plays to weigh in this period");
      const fromClaude = await claudeWeights(statement);
      // A proposal made while Claude was thinking may have been approved meanwhile.
      if (current(developerId, period)?.status === "approved") return fail(409, "this period's Weighting is approved and locked");
      const now = clock();
      const weighting: Weighting = {
        period,
        status: "proposed",
        proposed_by: fromClaude ? "claude" : "play counts",
        proposed_at: now.toISOString(),
        auto_approves_at: new Date(now.getTime() + AUTO_APPROVE_AFTER_MS).toISOString(),
        adjusted: false,
        shares: toShares(fromClaude ?? byPlays(statement.projects)),
      };
      ledger.recordWeighting(developerId, weighting);
      return done(weighting);
    },

    adjust(developerId: string, period: string, value: unknown): WeightingResult {
      const weighting = current(developerId, period);
      if (!weighting) return fail(404, "no Weighting proposed for this period");
      if (weighting.status === "approved") return fail(409, "this period's Weighting is approved and locked");
      const shares = parseAdjustment(value, weighting.shares);
      if (typeof shares === "string") return fail(400, shares);
      const adjusted: Weighting = {
        ...weighting,
        adjusted: true,
        shares: weighting.shares.map((s) => ({ ...s, share: shares.get(s.project)! / 100 })).sort(byShare),
      };
      ledger.recordWeighting(developerId, adjusted);
      return done(adjusted);
    },

    approve(developerId: string, period: string): WeightingResult {
      const weighting = current(developerId, period);
      if (!weighting) return fail(404, "no Weighting proposed for this period");
      if (weighting.status === "approved") return fail(409, "this period's Weighting is already approved");
      const approved: Weighting = { ...weighting, status: "approved", approved_by: "developer", approved_at: clock().toISOString() };
      ledger.recordWeighting(developerId, approved);
      return done(approved);
    },
  };
}
