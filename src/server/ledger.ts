import type { Play } from "../play.ts";

// Called with each newly recorded Play and its number in the Developer's Play log (1-based).
export type PlayListener = (play: Play, number: number) => void;

// What a Developer commits to pay each month, in integer US cents. A Budget funded through PayPal
// names its Subscription; the seeded demo Developer's Budget has none.
export type Budget = { amountCents: number; subscriptionId?: string; since: string };

// The Ledger owns everything PlayCount records about money and usage.
// For now it holds Plays and Budgets; Weightings and Royalties arrive with later tickets.
export interface Ledger {
  recordPlays(developerId: string, plays: Play[]): void;
  playsOf(developerId: string): Play[];
  // Listens for one Developer's new Plays; returns a function that stops listening.
  onPlays(developerId: string, listener: PlayListener): () => void;
  // Records the Developer's Budget unless they already have one; returns whether it was recorded.
  recordBudget(developerId: string, budget: Budget): boolean;
  // The Budget Settlement draws on, if the Developer has one.
  budgetOf(developerId: string): Budget | undefined;
}

export function inMemoryLedger(): Ledger {
  const plays = new Map<string, Play[]>();
  const listeners = new Map<string, Set<PlayListener>>();
  const budgets = new Map<string, Budget>();
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
  };
}
