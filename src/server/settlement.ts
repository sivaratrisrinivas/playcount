// Settlement: turns a Developer's approved Weighting for one period into Royalties, pays the
// claimed Projects in one PayPal Payouts batch, holds Unclaimed royalties in the Ledger and rolls
// Royalties under $1 over to the Developer's next Settlement. A period is settled once: settling
// it again returns the same Settlement, and a batch PayPal did not confirm is retried under the
// same batch id, which PayPal refuses to pay twice. Once a batch is sent, reconciliation reads each
// payout item's status back from PayPal until all are final; a payout PayPal fails or returns
// puts its Royalty back in the Pool, held for its Project.
import { randomBytes } from "node:crypto";
import type { Ledger } from "./ledger.ts";
import { isFinalPayout, isRejectedBatch, senderItemId, type PayoutBatch, type PayoutItem, type PayoutItemStatus, type PayPal } from "./paypal.ts";
import { periodOf, statementOf } from "./statement.ts";
import type { Weighting } from "./weighting.ts";

// PayPal's fee per payout item, observed in the sandbox. It is paid from the Pool, out of the
// Developer's spendable amount before the split, so each Project receives its full Royalty.
export const PAYOUT_FEE_CENTS = 25;
// A Royalty under $1 rolls over rather than being paid or held.
const MIN_ROYALTY_CENTS = 100;
const WHOLE = 10_000; // 100%, in hundredths of a percent

// "sending" only while the Payouts batch is unconfirmed; it becomes "sent" once PayPal takes it,
// then "paid" when PayPal delivers it, or "returned-held" when PayPal fails or returns the payout.
// A simulated Budget collects no money, so a claimed Project's Royalty from one is "simulated":
// recorded, never sent, so no real Budget's money ever pays for simulated Plays.
export type RoyaltyStatus = "sending" | "sent" | "paid" | "returned-held" | "unclaimed-held" | "rolled-over" | "simulated";
// A paid-out Royalty's payout item as PayPal last reported it, with the fee PayPal charged for it.
export type Payout = { item_id?: string; status: PayoutItemStatus; fee_cents: number };
export type Royalty = { project: string; share: number; amount_cents: number; status: RoyaltyStatus; payout?: Payout };

// All amounts are integer US cents, and every cent of the spendable amount (Budget plus the
// Rollover carried in) is accounted for: sent + held + rolled over + fees (+ simulated) = spendable.
export type Settlement = {
  id: string;
  period: string;
  status: "sending" | "payout-failed" | "settled";
  settled_at: string;
  budget_cents: number;
  rollover_in_cents: number;
  spendable_cents: number;
  royalties: Royalty[];
  // Payout items sent. Each has PAYOUT_FEE_CENTS set aside; a fee PayPal does not charge rolls over.
  payouts: number;
  fees_cents: number;
  sent_cents: number;
  held_cents: number;
  rolled_over_cents: number;
  payout_batch_id?: string;
  // When PayPal's payout statuses were last read back.
  reconciled_at?: string;
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

// The Royalty statuses whose money went to PayPal, was delivered, or is held in the Pool.
const TO_PAYPAL: RoyaltyStatus[] = ["sent", "paid", "returned-held"];
const DELIVERED: RoyaltyStatus[] = ["sent", "paid"];
const HELD: RoyaltyStatus[] = ["unclaimed-held", "returned-held"];
const total = (royalties: Royalty[], statuses: RoyaltyStatus[]) => statuses.reduce((t, status) => t + sum(royalties, status), 0);

// Whether any of the Settlement's payouts is still with PayPal, its status not yet final.
export const awaitingPayPal = (s: Pick<Settlement, "status" | "royalties">) => s.status === "settled" && s.royalties.some((r) => r.status === "sent");

const royaltyStatusOf = (status: PayoutItemStatus): RoyaltyStatus => {
  if (!isFinalPayout(status)) return "sent";
  return status === "SUCCESS" ? "paid" : "returned-held";
};

// The Settlement's totals once PayPal's payout statuses are read back: a Royalty PayPal did not
// deliver is held, and a fee PayPal did not charge rolls over, so every spendable cent is still
// accounted for. If a later period is already settled, that fee reaches the one after it.
function totalsAfterReconciliation(settlement: Settlement, royalties: Royalty[]): Settlement {
  const fee = (r: Royalty) =>
    r.payout && isFinalPayout(r.payout.status) ? Math.min(r.payout.fee_cents, PAYOUT_FEE_CENTS) : PAYOUT_FEE_CENTS;
  const fees = royalties.filter((r) => TO_PAYPAL.includes(r.status)).reduce((t, r) => t + fee(r), 0);
  const sent = total(royalties, DELIVERED);
  const held = total(royalties, HELD);
  return { ...settlement, royalties, fees_cents: fees, sent_cents: sent, held_cents: held, rolled_over_cents: settlement.spendable_cents - sent - held - fees - (settlement.simulated_cents ?? 0) };
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
  // Settlements whose payout statuses are being read back right now, by Developer and period.
  const reconciling = new Map<string, Promise<SettlementResult>>();

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
    const royalties: Royalty[] = [];
    const items: PayoutItem[] = [];
    // A period with no Plays needs no Weighting: the whole spendable amount rolls over.
    if (statementOf(ledger.playsOf(developerId), period).projects.length) {
      const weighting = currentWeighting(developerId, period);
      if (weighting?.status !== "approved") {
        return fail(409, weighting ? "approve this period's Weighting before settling" : "propose and approve this period's Weighting before settling");
      }
      const shares = weighting.shares.filter((s) => s.share > 0).map((s) => ({ ...s, claim: ledger.claimOf(s.project) }));
      // Each claimed Project's payout fee is set aside first. If its Royalty then rolls over,
      // so does the fee set aside for it.
      const claimed = simulated ? 0 : shares.filter((s) => s.claim).length;
      const amounts = split(Math.max(0, spendable - claimed * PAYOUT_FEE_CENTS), shares.map((s) => Math.round(s.share * 100)));
      shares.forEach((s, i) => {
        const status = amounts[i] < MIN_ROYALTY_CENTS ? "rolled-over" : !s.claim ? "unclaimed-held" : simulated ? "simulated" : "sending";
        royalties.push({ project: s.project, share: s.share, amount_cents: amounts[i], status });
        if (status === "sending") {
          items.push({
            project: s.project,
            receiver: s.claim!.payoutEmail,
            amountCents: amounts[i],
            note: `Developers' AI coding agents relied on ${s.project} in ${period}. This royalty comes from their PlayCount budgets.`,
          });
        }
      });
    }

    if (items.length && !paypal) return fail(503, NO_PAYPAL);
    const id = `pc-${randomBytes(8).toString("hex")}`;
    const sent = sum(royalties, "sending");
    const held = sum(royalties, "unclaimed-held");
    const fees = items.length * PAYOUT_FEE_CENTS;
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
      payouts: items.length,
      fees_cents: fees,
      sent_cents: sent,
      held_cents: held,
      rolled_over_cents: spendable - sent - held - fees - simulatedCents,
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

  async function readPayoutStatuses(developerId: string, settlement: Settlement): Promise<SettlementResult> {
    const { batch, payout_batch_id } = settlement;
    if (!batch || !payout_batch_id || !awaitingPayPal(settlement)) return { ok: true, status: 200, settlement };
    if (!paypal) return fail(503, NO_PAYPAL);
    const answer = await paypal.payoutBatch(payout_batch_id).catch((err) => {
      console.error(`PayPal payout statuses for ${developerId} ${settlement.period} could not be read:`, err);
    });
    if (!answer) return fail(502, "PayPal did not answer with the payout statuses. Try again in a moment");
    const itemOf = (project: string) => {
      const i = batch.items.findIndex((item) => item.project === project);
      const item = answer.items.find((s) => s.senderItemId === senderItemId(batch.senderBatchId, i));
      // A batch PayPal rejected pays none of its items, listed or not, and charges no fee.
      if (!item && isRejectedBatch(answer.status)) return { status: "DENIED", feeCents: 0 } as const;
      return item;
    };
    const royalties = settlement.royalties.map((r) => {
      // A final status never changes again, and only payouts PayPal reports on are updated.
      const item = r.status === "sent" ? itemOf(r.project) : undefined;
      if (!item) return r;
      const payout: Payout = { item_id: "payoutItemId" in item ? item.payoutItemId : undefined, status: item.status, fee_cents: item.feeCents };
      return { ...r, status: royaltyStatusOf(item.status), payout };
    });
    const reconciled = { ...totalsAfterReconciliation(settlement, royalties), reconciled_at: clock().toISOString() };
    ledger.recordSettlement(developerId, reconciled);
    return { ok: true, status: 200, settlement: reconciled };
  }

  // Reads the period's payout statuses back from PayPal, unless every one is already final.
  function reconcile(developerId: string, period: string): Promise<SettlementResult> {
    const key = `${developerId} ${period}`;
    const running = reconciling.get(key);
    if (running) return running;
    const settlement = ledger.settlementOf(developerId, period);
    if (!settlement) return Promise.resolve(fail(404, "this period has not been settled"));
    if (settlement.status !== "settled") return Promise.resolve(fail(409, "this period's payouts have not reached PayPal yet; settle again to retry them"));
    const done = readPayoutStatuses(developerId, settlement).finally(() => reconciling.delete(key));
    reconciling.set(key, done);
    return done;
  }

  return {
    reconcile,

    // Reconciles every Settlement that still has a payout PayPal has not finished.
    async reconcileAll() {
      for (const { developerId, settlement } of ledger.allSettlements()) {
        if (awaitingPayPal(settlement)) await reconcile(developerId, settlement.period);
      }
    },

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
