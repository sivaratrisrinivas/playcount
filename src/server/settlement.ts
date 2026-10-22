// Settlement: turns a Developer's approved Weighting for one period into Royalties, pays the
// claimed Projects in one PayPal Payouts batch, holds Unclaimed royalties in the Ledger and rolls
// Royalties under $1 over to the Developer's next Settlement. Unclaimed royalties the Developer's
// earlier Settlements held for a Project are paid in their first Settlement after it is claimed.
// A period is settled once: settling it again returns the same Settlement, and a batch PayPal did
// not confirm is retried under the same batch id, which PayPal refuses to pay twice.
import { randomBytes } from "node:crypto";
import type { Claim, Ledger } from "./ledger.ts";
import type { PayoutBatch, PayoutItem, PayPal } from "./paypal.ts";
import { periodOf, statementOf } from "./statement.ts";
import type { Weighting } from "./weighting.ts";

// PayPal's fee per payout item, observed in the sandbox. It is paid from the Pool, out of the
// Developer's spendable amount before the split, so each Project receives its full Royalty.
export const PAYOUT_FEE_CENTS = 25;
// A Royalty under $1 rolls over rather than being paid or held.
const MIN_ROYALTY_CENTS = 100;
const WHOLE = 10_000; // 100%, in hundredths of a percent

// "sending" only while the Payouts batch is unconfirmed; it becomes "sent" once PayPal takes it.
// A simulated Budget collects no money, so a claimed Project's Royalty from one is "simulated":
// recorded, never sent, so no real Budget's money ever pays for simulated Plays.
export type RoyaltyStatus = "sending" | "sent" | "unclaimed-held" | "rolled-over" | "simulated";
export type Royalty = { project: string; share: number; amount_cents: number; status: RoyaltyStatus };
// Unclaimed royalties earlier Settlements held for a Project, paid by this one now it is claimed.
// A simulated Developer's are recorded as "simulated", never sent.
export type Release = { project: string; amount_cents: number; status: "sending" | "sent" | "simulated" };

// All amounts are integer US cents, and every cent of the spendable amount (Budget plus the
// Rollover carried in) is accounted for: sent + held + rolled over + fees (+ simulated) = spendable.
// Released royalties were accounted for by the Settlements that held them, so they are paid on top.
export type Settlement = {
  id: string;
  period: string;
  status: "sending" | "payout-failed" | "settled";
  settled_at: string;
  budget_cents: number;
  rollover_in_cents: number;
  spendable_cents: number;
  royalties: Royalty[];
  releases: Release[];
  released_cents: number;
  // Payout items sent, each costing one PAYOUT_FEE_CENTS.
  payouts: number;
  fees_cents: number;
  sent_cents: number;
  held_cents: number;
  rolled_over_cents: number;
  payout_batch_id?: string;
  // Set when a simulated Developer's Budget paid for it, with the Royalties it recorded but never sent.
  simulated?: true;
  simulated_cents?: number;
  // What is sent to PayPal, kept so a retry sends exactly the same batch.
  batch?: PayoutBatch;
};

export type SettlementResult =
  | { ok: true; status: 200 | 201; settlement: Settlement }
  | { ok: false; status: 404 | 409 | 422 | 502 | 503; error: string };

const fail = (status: 404 | 409 | 422 | 502 | 503, error: string): SettlementResult => ({ ok: false, status, error });
const NO_PAYPAL = "PayPal is not configured on this PlayCount service, so Royalties cannot be paid";

// What a Developer or the dashboard sees: the payout addresses stay in the Ledger.
export type PublicSettlement = Omit<Settlement, "batch">;
export const publicSettlement = ({ batch: _, ...settlement }: Settlement): PublicSettlement => settlement;

// Splits cents by shares (in hundredths of a percent, summing to 100%), handing leftover cents to
// the largest remainders so the amounts always sum to exactly `cents`.
function split(cents: number, hundredths: number[]): number[] {
  const parts = hundredths.map((h) => Math.floor((cents * h) / WHOLE));
  let left = cents - parts.reduce((a, b) => a + b, 0);
  const order = hundredths.map((h, i) => ({ i, rem: (cents * h) % WHOLE })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left-- <= 0) break;
    parts[i]++;
  }
  return parts;
}

const sum = (royalties: Royalty[], status: RoyaltyStatus) =>
  royalties.filter((r) => r.status === status).reduce((total, r) => total + r.amount_cents, 0);

// What these Settlements still hold for each Project: their Unclaimed royalties, less what
// Settlements since have released. A release counts from the moment it is recorded, even before
// PayPal confirms it, so a held Royalty is never paid twice.
export function heldByProject(settlements: Settlement[]): Map<string, number> {
  const held = new Map<string, number>();
  const add = (project: string, cents: number) => held.set(project, (held.get(project) ?? 0) + cents);
  for (const s of settlements) {
    for (const r of s.royalties) if (r.status === "unclaimed-held") add(r.project, r.amount_cents);
    for (const r of s.releases) add(r.project, -r.amount_cents);
  }
  return held;
}

export function settlementService({
  ledger,
  currentWeighting,
  paypal,
  clock,
}: {
  ledger: Ledger;
  // The period's Weighting, read through weightingService().current so it auto-approves on time.
  currentWeighting: (developerId: string, period: string) => Weighting | undefined;
  paypal?: PayPal;
  clock: () => Date;
}) {
  // Settlements whose Payouts batch is with PayPal right now, by Developer and period.
  const paying = new Set<string>();

  // The Rollover the Developer's next Settlement starts with: everything rolled over so far,
  // less what earlier Settlements already carried in.
  const rolloverOf = (settled: Settlement[]) => settled.reduce((total, s) => total + s.rolled_over_cents - s.rollover_in_cents, 0);

  function compute(developerId: string, period: string): Settlement | SettlementResult {
    const budget = ledger.budgetOf(developerId);
    if (!budget) return fail(422, "there is no Budget to settle; choose one first");
    if (period > periodOf(clock())) return fail(422, "this period has not begun");
    if (period < periodOf(new Date(budget.since))) return fail(422, "your Budget began after this period");
    // Periods settle in order, so a Rollover only ever moves forward to a later period.
    const settled = ledger.settlementsOf(developerId);
    const latest = settled.map((s) => s.period).sort().at(-1);
    if (latest && period < latest) return fail(422, `${latest} is already settled, so earlier periods can no longer be`);

    const { simulated } = budget;
    const rolloverIn = rolloverOf(settled);
    const spendable = budget.amountCents + rolloverIn;
    // A period with no Plays needs no Weighting: the whole spendable amount rolls over.
    let shares: { project: string; share: number; claim?: Claim }[] = [];
    if (statementOf(ledger.playsOf(developerId), period).projects.length) {
      const weighting = currentWeighting(developerId, period);
      if (weighting?.status !== "approved") {
        return fail(409, weighting ? "approve this period's Weighting before settling" : "propose and approve this period's Weighting before settling");
      }
      shares = weighting.shares.filter((s) => s.share > 0).map((s) => ({ project: s.project, share: s.share, claim: ledger.claimOf(s.project) }));
    }

    // Each claimed Project's payout fee is set aside first. If its Royalty then rolls over, so
    // does the fee set aside for it. A simulated Budget sends nothing, so it sets no fee aside.
    const claims = new Map(shares.flatMap((s) => (s.claim ? [[s.project, s.claim] as const] : [])));
    // Held royalties for Projects claimed since are released. A Project paid this period too gets
    // one payout item for both; any other needs a fee of its own, and stays held until a
    // Settlement has enough to set that fee aside.
    const releases: Release[] = [];
    for (const [project, cents] of heldByProject(settled)) {
      const claim = cents > 0 ? ledger.claimOf(project) : undefined;
      if (!claim) continue;
      if (simulated) {
        releases.push({ project, amount_cents: cents, status: "simulated" });
        continue;
      }
      if (!claims.has(project)) {
        if ((claims.size + 1) * PAYOUT_FEE_CENTS > spendable) continue;
        claims.set(project, claim);
      }
      releases.push({ project, amount_cents: cents, status: "sending" });
    }

    const royalties: Royalty[] = [];
    const fees = simulated ? 0 : claims.size * PAYOUT_FEE_CENTS;
    const amounts = split(Math.max(0, spendable - fees), shares.map((s) => Math.round(s.share * 100)));
    shares.forEach((s, i) => {
      const status = amounts[i] < MIN_ROYALTY_CENTS ? "rolled-over" : !s.claim ? "unclaimed-held" : simulated ? "simulated" : "sending";
      royalties.push({ project: s.project, share: s.share, amount_cents: amounts[i], status });
    });

    const items: PayoutItem[] = [];
    for (const [project, claim] of simulated ? [] : claims) {
      const royalty = royalties.find((r) => r.project === project && r.status === "sending")?.amount_cents ?? 0;
      const released = releases.find((r) => r.project === project)?.amount_cents ?? 0;
      if (!royalty && !released) continue;
      const when = !released ? `in ${period}` : royalty ? `in ${period} and earlier months` : "in earlier months";
      const held = released ? ` It includes royalties held for ${project} until it was claimed.` : "";
      items.push({
        project,
        receiver: claim.payoutEmail,
        amountCents: royalty + released,
        note: `Developers' AI coding agents relied on ${project} ${when}. This royalty comes from their PlayCount budgets.${held}`,
      });
    }

    if (items.length && !paypal) return fail(503, NO_PAYPAL);
    const id = `pc-${randomBytes(8).toString("hex")}`;
    const sent = sum(royalties, "sending");
    const held = sum(royalties, "unclaimed-held");
    const feesCents = items.length * PAYOUT_FEE_CENTS;
    const simulatedCents = sum(royalties, "simulated");
    return {
      id,
      period,
      status: "sending",
      settled_at: clock().toISOString(),
      budget_cents: budget.amountCents,
      rollover_in_cents: rolloverIn,
      spendable_cents: spendable,
      royalties,
      releases,
      released_cents: releases.reduce((total, r) => total + r.amount_cents, 0),
      payouts: items.length,
      fees_cents: feesCents,
      sent_cents: sent,
      held_cents: held,
      rolled_over_cents: spendable - sent - held - feesCents - simulatedCents,
      batch: items.length ? { senderBatchId: id, items } : undefined,
      ...(simulated && { simulated, simulated_cents: simulatedCents }),
    };
  }

  async function pay(developerId: string, settlement: Settlement): Promise<SettlementResult> {
    const key = `${developerId} ${settlement.period}`;
    const settled = (payout_batch_id?: string): SettlementResult => {
      const done: Settlement = {
        ...settlement,
        status: "settled",
        settled_at: clock().toISOString(),
        payout_batch_id,
        royalties: settlement.royalties.map((r) => (r.status === "sending" ? { ...r, status: "sent" } : r)),
        releases: settlement.releases.map((r) => (r.status === "sending" ? { ...r, status: "sent" } : r)),
      };
      ledger.recordSettlement(developerId, done);
      return { ok: true, status: 201, settlement: done };
    };
    if (!settlement.batch) return settled();
    if (!paypal) return fail(503, NO_PAYPAL);

    paying.add(key);
    try {
      const { payoutBatchId } = await paypal.sendPayouts(settlement.batch);
      return settled(payoutBatchId);
    } catch (err) {
      console.error(`PayPal Payouts failed for ${key}:`, err);
      ledger.recordSettlement(developerId, { ...settlement, status: "payout-failed" });
      return fail(502, "PayPal did not confirm the payouts. Settle again to retry; no Royalty is ever paid twice");
    } finally {
      paying.delete(key);
    }
  }

  return {
    read(developerId: string, period: string): SettlementResult {
      const settlement = ledger.settlementOf(developerId, period);
      return settlement ? { ok: true, status: 200, settlement } : fail(404, "this period has not been settled");
    },

    // Settles the period, or returns its Settlement if it is already settled. A Settlement whose
    // payouts PayPal did not confirm is paid again exactly as first computed.
    async settle(developerId: string, period: string): Promise<SettlementResult> {
      const existing = ledger.settlementOf(developerId, period);
      if (existing?.status === "settled") return { ok: true, status: 200, settlement: existing };
      if (paying.has(`${developerId} ${period}`)) return fail(409, "this period's payouts are with PayPal now; reload in a moment");
      if (existing) return pay(developerId, existing);
      const computed = compute(developerId, period);
      if ("ok" in computed) return computed;
      // Recorded before PayPal is called, so a second Settlement of the period finds it.
      ledger.recordSettlement(developerId, computed);
      return pay(developerId, computed);
    },
  };
}
