import type { Play } from "../play.ts";
import type { Settlement } from "./settlement.ts";
import type { Weighting } from "./weighting.ts";

// Called with each newly recorded Play and its number in the Developer's Play log (1-based).
export type PlayListener = (play: Play, number: number) => void;

// What a Developer commits to pay each month, in integer US cents. A Budget funded through PayPal
// names its Subscription; the seeded demo Developer's Budget has none.
export type Budget = { amountCents: number; subscriptionId?: string; since: string };

// A Project's Claim: where its Royalties are paid. Until Claims (#13) arrive, Claims are seeded.
export type Claim = { payoutEmail: string };

// The Ledger owns everything PlayCount records about money and usage: Plays, Budgets,
// Weightings, Claims and Settlements, whose Royalties say what was sent, held or rolled over.
export interface Ledger {
  recordPlays(developerId: string, plays: Play[]): void;
  playsOf(developerId: string): Play[];
  // Listens for one Developer's new Plays; returns a function that stops listening.
  onPlays(developerId: string, listener: PlayListener): () => void;
  // Records the Developer's Budget unless they already have one; returns whether it was recorded.
  recordBudget(developerId: string, budget: Budget): boolean;
  // The Budget Settlement draws on, if the Developer has one.
  budgetOf(developerId: string): Budget | undefined;
  // One Weighting per Developer and period; recording one replaces the last.
  weightingOf(developerId: string, period: string): Weighting | undefined;
  recordWeighting(developerId: string, weighting: Weighting): void;
  // Records the Project's Claim unless it already has one; returns whether it was recorded.
  recordClaim(project: string, claim: Claim): boolean;
  claimOf(project: string): Claim | undefined;
  // One Settlement per Developer and period; recording one replaces the last.
  settlementOf(developerId: string, period: string): Settlement | undefined;
  settlementsOf(developerId: string): Settlement[];
  recordSettlement(developerId: string, settlement: Settlement): void;
}

export function inMemoryLedger(): Ledger {
  const plays = new Map<string, Play[]>();
  const listeners = new Map<string, Set<PlayListener>>();
  const budgets = new Map<string, Budget>();
  const weightings = new Map<string, Weighting>();
  const claims = new Map<string, Claim>();
  const settlements = new Map<string, Map<string, Settlement>>();
  const weightingKey = (developerId: string, period: string) => `${developerId} ${period}`;
  return {
    recordPlays(developerId, batch) {
      const before = plays.get(developerId) ?? [];
      plays.set(developerId, [...before, ...batch]);
      for (const listener of listeners.get(developerId) ?? []) {
        batch.forEach((play, i) => listener(play, before.length + i + 1));
      }
    },
    playsOf(developerId) {
      return [...(plays.get(developerId) ?? [])];
    },
    onPlays(developerId, listener) {
      const set = listeners.get(developerId) ?? new Set();
      listeners.set(developerId, set.add(listener));
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(developerId);
      };
    },
    recordBudget(developerId, budget) {
      if (budgets.has(developerId)) return false;
      budgets.set(developerId, { ...budget });
      return true;
    },
    budgetOf: (developerId) => budgets.get(developerId),
    weightingOf(developerId, period) {
      const weighting = weightings.get(weightingKey(developerId, period));
      return weighting && structuredClone(weighting);
    },
    recordWeighting(developerId, weighting) {
      weightings.set(weightingKey(developerId, weighting.period), structuredClone(weighting));
    },
    recordClaim(project, claim) {
      if (claims.has(project)) return false;
      claims.set(project, { ...claim });
      return true;
    },
    claimOf(project) {
      const claim = claims.get(project);
      return claim && { ...claim };
    },
    settlementOf(developerId, period) {
      const settlement = settlements.get(developerId)?.get(period);
      return settlement && structuredClone(settlement);
    },
    settlementsOf(developerId) {
      return [...(settlements.get(developerId)?.values() ?? [])].map((s) => structuredClone(s));
    },
    recordSettlement(developerId, settlement) {
      const mine = settlements.get(developerId) ?? new Map<string, Settlement>();
      settlements.set(developerId, mine.set(settlement.period, structuredClone(settlement)));
    },
  };
}
