// Settlement: turns a Developer's approved Weighting for one period into Royalties, pays the
// claimed Projects in one PayPal Payouts batch, holds Unclaimed royalties in the Ledger and rolls
// Royalties under $1 over to the Developer's next Settlement. A period is settled once: settling
// it again returns the same Settlement, and a batch PayPal did not confirm is retried under the
// same batch id, which PayPal refuses to pay twice.
import { randomBytes } from "node:crypto";
import type { Ledger } from "./ledger.ts";
import type { PayoutBatch, PayPal } from "./paypal.ts";
import { periodOf, statementOf } from "./statement.ts";
import type { Weighting } from "./weighting.ts";

// PayPal's fee per payout item, observed in the sandbox. It is paid from the Pool, out of the
// Developer's spendable amount before the split, so each Project receives its full Royalty.
export const PAYOUT_FEE_CENTS = 25;
// A Royalty under $1 rolls over rather than being paid or held.
const MIN_ROYALTY_CENTS = 100;
const WHOLE = 10_000; // 100%, in hundredths of a percent

// "sending" only while the Payouts batch is unconfirmed; it becomes "sent" once PayPal takes it.
export type RoyaltyStatus = "sending" | "sent" | "unclaimed-held" | "rolled-over";
export type Royalty = { project: string; share: number; amount_cents: number; status: RoyaltyStatus };

// All amounts are integer US cents, and every cent of the spendable amount (Budget plus the
// Rollover carried in) is accounted for: sent + held + rolled over + fees = spendable.
export type Settlement = {
  id: string;
  period: string;
  status: "sending" | "payout-failed" | "settled";
  settled_at: string;
  budget_cents: number;
  rollover_in_cents: number;
  spendable_cents: number;
  royalties: Royalty[];
  // Payout items sent, each costing one PAYOUT_FEE_CENTS.
  payouts: number;
  fees_cents: number;
  sent_cents: number;
  held_cents: number;
  rolled_over_cents: number;
  payout_batch_id?: string;
  // What is sent to PayPal, kept so a retry sends exactly the same batch.
  batch?: PayoutBatch;
};

export type SettlementResult =
  | { ok: true; status: 200 | 201; settlement: Settlement }
  | { ok: false; status: 404 | 409 | 422 | 502 | 503; error: string };

const fail = (status: 404 | 409 | 422 | 502 | 503, error: string): SettlementResult => ({ ok: false, status, error });

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
  const rolloverOf = (developerId: string) =>
    ledger.settlementsOf(developerId).reduce((total, s) => total + s.rolled_over_cents - s.rollover_in_cents, 0);

  function compute(developerId: string, period: string): Settlement | SettlementResult {
    const budget = ledger.budgetOf(developerId);
    if (!budget) return fail(422, "there is no Budget to settle; choose one first");
    if (period > periodOf(clock())) return fail(422, "this period has not begun");
    if (period < periodOf(new Date(budget.since))) return fail(422, "your Budget began after this period");

    const rolloverIn = rolloverOf(developerId);
    const spendable = budget.amountCents + rolloverIn;
    let royalties: Royalty[] = [];
    // A period with no Plays needs no Weighting: the whole spendable amount rolls over.
    if (statementOf(ledger.playsOf(developerId), period).projects.length) {
      const weighting = currentWeighting(developerId, period);
      if (weighting?.status !== "approved") {
        return fail(409, weighting ? "approve this period's Weighting before settling" : "propose and approve this period's Weighting before settling");
      }
      const shares = weighting.shares.filter((s) => s.share > 0);
      // Each claimed Project's payout fee is set aside first. If its Royalty then rolls over,
      // so does the fee set aside for it.
      const claimed = shares.filter((s) => ledger.claimOf(s.project)).length;
      const amounts = split(Math.max(0, spendable - claimed * PAYOUT_FEE_CENTS), shares.map((s) => Math.round(s.share * 100)));
      royalties = shares.map((s, i) => ({
        project: s.project,
        share: s.share,
        amount_cents: amounts[i],
        status: amounts[i] < MIN_ROYALTY_CENTS ? "rolled-over" : ledger.claimOf(s.project) ? "sending" : "unclaimed-held",
      }));
    }

    const id = `pc-${randomBytes(8).toString("hex")}`;
    const items = royalties
      .filter((r) => r.status === "sending")
      .map((r) => ({
        project: r.project,
        receiver: ledger.claimOf(r.project)!.payoutEmail,
        amountCents: r.amount_cents,
        note: `Developers' AI coding agents relied on ${r.project} in ${period}. This royalty comes from their PlayCount budgets.`,
      }));
    if (items.length && !paypal) return fail(503, "PayPal is not configured on this PlayCount service, so Royalties cannot be paid");
    const sent = sum(royalties, "sending");
    const held = sum(royalties, "unclaimed-held");
    const fees = items.length * PAYOUT_FEE_CENTS;
    return {
      id,
      period,
      status: "sending",
      settled_at: clock().toISOString(),
      budget_cents: budget.amountCents,
      rollover_in_cents: rolloverIn,
      spendable_cents: spendable,
      royalties,
      payouts: items.length,
      fees_cents: fees,
      sent_cents: sent,
      held_cents: held,
      rolled_over_cents: spendable - sent - held - fees,
      batch: items.length ? { senderBatchId: id, items } : undefined,
    };
  }

  async function pay(developerId: string, settlement: Settlement): Promise<SettlementResult> {
    const key = `${developerId} ${settlement.period}`;
    const settled = (payout_batch_id?: string): SettlementResult => {
      const done: Settlement = {
        ...settlement,
        status: "settled",
        payout_batch_id,
        royalties: settlement.royalties.map((r) => (r.status === "sending" ? { ...r, status: "sent" } : r)),
      };
      ledger.recordSettlement(developerId, done);
      return { ok: true, status: 201, settlement: done };
    };
    if (!settlement.batch) return settled();
    if (!paypal) return fail(503, "PayPal is not configured on this PlayCount service, so Royalties cannot be paid");

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
