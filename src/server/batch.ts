// The monthly batch: settles every Developer's ended periods, so maintainers are paid without
// anyone pressing "settle now". It runs often (see server.ts) but each period settles once: a
// settled period is skipped, and settling one again only returns its Settlement, so the batch
// and "settle now" can never pay a Royalty twice.
import type { Developer, Developers } from "./developers.ts";
import type { Ledger } from "./ledger.ts";
import type { SettlementResult } from "./settlement.ts";
import { nextPeriod, periodOf, statementOf } from "./statement.ts";
import type { weightingService } from "./weighting.ts";

export type BatchDeps = {
  ledger: Ledger;
  developers: Developers;
  weightings: Pick<ReturnType<typeof weightingService>, "current" | "propose" | "approve">;
  settle(developerId: string, period: string): Promise<SettlementResult>;
  clock: () => Date;
};

// What one run did for each Developer it looked at, for the service log.
export type BatchReport = { developer: string; period: string; outcome: string }[];

export function monthlyBatch({ ledger, developers, weightings, settle, clock }: BatchDeps) {
  let running: Promise<BatchReport> | undefined;

  // Settles the Developer's ended periods in order, stopping at the first that is not ready:
  // periods settle in order, so a later one must wait for it.
  async function settleDeveloper(developer: Developer, report: BatchReport) {
    const budget = ledger.budgetOf(developer.id);
    if (!budget) return;
    const current = periodOf(clock());
    const latest = ledger.settlementsOf(developer.id).filter((s) => s.status === "settled").map((s) => s.period).sort().at(-1);
    // A period whose payouts PayPal did not confirm is not settled yet, so it is retried here.
    for (let period = latest ? nextPeriod(latest) : periodOf(new Date(budget.since)); period < current; period = nextPeriod(period)) {
      const log = (outcome: string) => report.push({ developer: developer.name, period, outcome });
      if (statementOf(ledger.playsOf(developer.id), period).projects.length) {
        let weighting = weightings.current(developer.id, period);
        if (!weighting) {
          const proposed = await weightings.propose(developer.id, period);
          if (!proposed.ok) return log(`could not propose a Weighting: ${proposed.error}`);
          weighting = proposed.weighting;
        }
        // Nobody is there to approve a simulated Developer's Weighting, so the batch does.
        if (weighting.status === "proposed" && budget.simulated) {
          const approved = weightings.approve(developer.id, period, "simulated");
          if (!approved.ok) return log(`could not approve the Weighting: ${approved.error}`);
          weighting = approved.weighting;
        }
        if (weighting.status !== "approved") return log(`waiting for the Weighting to be approved (auto-approves ${weighting.auto_approves_at})`);
      }
      const result = await settle(developer.id, period);
      if (!result.ok) return log(`not settled: ${result.error}`);
      if (result.status === 201) log("settled");
    }
  }

  async function run(): Promise<BatchReport> {
    const report: BatchReport = [];
    for (const developer of developers.all()) {
      try {
        await settleDeveloper(developer, report);
      } catch (err) {
        report.push({ developer: developer.name, period: "", outcome: `failed: ${(err as Error).message}` });
      }
    }
    return report;
  }

  return {
    // One run at a time: a run asked for while one is going joins it.
    run(): Promise<BatchReport> {
      running ??= run().finally(() => (running = undefined));
      return running;
    },
  };
}
