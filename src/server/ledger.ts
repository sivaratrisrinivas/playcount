import type { Play } from "../play.ts";

// The Ledger owns everything PlayCount records about money and usage.
// For now it holds Plays; Budgets, Weightings and Royalties arrive with later tickets.
export interface Ledger {
  recordPlays(developerId: string, plays: Play[]): void;
  playsOf(developerId: string): Play[];
}

export function inMemoryLedger(): Ledger {
  const plays = new Map<string, Play[]>();
  return {
    recordPlays(developerId, batch) {
      plays.set(developerId, [...(plays.get(developerId) ?? []), ...batch]);
    },
    playsOf(developerId) {
      return [...(plays.get(developerId) ?? [])];
    },
  };
}
