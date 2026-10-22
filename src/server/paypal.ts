// The PayPal adapter: Subscriptions that fund Developers' Budgets, and Payouts batches that pay
// Projects their Royalties. The real one talks to PayPal's REST API; tests use the fake.

// PayPal's Subscription statuses. Only ACTIVE means the Developer approved it and was charged.
export type SubscriptionStatus = "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";

export type Subscription = {
  id: string;
  status: SubscriptionStatus;
  // The monthly price, in integer US cents.
  amountCents: number;
  // Whose Budget this Subscription funds: the Developer id it was created for.
  developerId: string;
};

export type NewSubscription = {
  amountCents: number;
  developerId: string;
  // Where PayPal sends the browser after approval, with ?subscription_id=…
  returnUrl: string;
  // Where PayPal sends the browser if the Developer cancels on PayPal's page.
  cancelUrl: string;
};

// One Royalty paid to one claimed Project's payout address.
export type PayoutItem = { project: string; receiver: string; amountCents: number; note: string };

export type PayoutBatch = {
  // Our id for the batch. PayPal refuses a second batch with the same id, so sending it again is
  // safe: it never pays twice, and the answer names the batch PayPal already has.
  senderBatchId: string;
  items: PayoutItem[];
};

// PayPal's status for one payout item. PENDING, UNCLAIMED and ONHOLD can still change; the rest
// are final. Only SUCCESS delivers the Royalty: in the others the money stays with PlayCount.
// (PayPal's UNCLAIMED means the receiver has not accepted the money yet; it is not an Unclaimed royalty.)
export type PayoutItemStatus =
  | "PENDING"
  | "UNCLAIMED"
  | "ONHOLD"
  | "SUCCESS"
  | "FAILED"
  | "RETURNED"
  | "REFUNDED"
  | "REVERSED"
  | "BLOCKED"
  | "DENIED";
const FINAL: string[] = ["SUCCESS", "FAILED", "RETURNED", "REFUNDED", "REVERSED", "BLOCKED", "DENIED"];
// A status PayPal sends that is not listed here is treated as still changing, never as final.
export const isFinalPayout = (status: PayoutItemStatus) => FINAL.includes(status);

// PayPal's status for a whole batch. A DENIED or CANCELED batch pays none of its items, and PayPal
// may then list no items at all. SUCCESS only means PayPal processed the batch: items can still fail.
export type PayoutBatchStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "DENIED" | "CANCELED";
export const isRejectedBatch = (status: PayoutBatchStatus) => status === "DENIED" || status === "CANCELED";

// One item of a Payouts batch as PayPal has it now. Its fee is what PayPal charged: the sandbox
// charges nothing for a FAILED item but keeps the fee of a RETURNED one.
export type PayoutItemState = { senderItemId: string; payoutItemId?: string; status: PayoutItemStatus; feeCents: number };

// Each item's sender_item_id is the batch id and the item's 1-based place in the batch.
export const senderItemId = (senderBatchId: string, index: number) => `${senderBatchId}-${index + 1}`;

export interface PayPal {
  // Creates a monthly Subscription awaiting the Developer's approval; returns PayPal's approve link.
  createSubscription(sub: NewSubscription): Promise<{ id: string; approveUrl: string }>;
  // The Subscription as PayPal has it now, or undefined if PayPal has no such Subscription.
  subscription(id: string): Promise<Subscription | undefined>;
  // Sends the batch, or finds the one PayPal already has under its senderBatchId; returns PayPal's batch id.
  sendPayouts(batch: PayoutBatch): Promise<{ payoutBatchId: string }>;
  // The batch and its items as PayPal has them now.
  payoutBatch(payoutBatchId: string): Promise<{ status: PayoutBatchStatus; items: PayoutItemState[] }>;
}

// PayPal's Subscription ids look like I-3LEKCLHWYE52.
export const isSubscriptionId = (id: string) => /^I-[A-Z0-9]{6,40}$/.test(id);

import { centsOf, decimal } from "./money.ts";

const SANDBOX_API = "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 15_000;

type Plan = { billing_cycles?: { tenure_type?: string; pricing_scheme?: { fixed_price?: { value?: string; currency_code?: string } } }[] };

// Every call uses HTTP Basic auth with the app's Client ID and Secret, which PayPal accepts
// on its REST API directly, so no access token is fetched or kept.
export function paypalRest({ clientId, clientSecret, apiUrl = SANDBOX_API }: { clientId: string; clientSecret: string; apiUrl?: string }): PayPal {
  const authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { authorization, accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, ok: res.ok, json };
  }
  async function must(method: string, path: string, body?: unknown) {
    const res = await call(method, path, body);
    if (!res.ok || !res.json) throw new Error(`PayPal ${method} ${path} answered ${res.status}: ${JSON.stringify(res.json)}`);
    return res.json;
  }

  // One Product, and one monthly Plan per Budget amount, created when first needed and kept for this run.
  let product: Promise<string> | undefined;
  const plans = new Map<number, Promise<string>>();
  const remember = <T>(p: Promise<T>, forget: () => void) => {
    p.catch(forget);
    return p;
  };
  const productId = () =>
    (product ??= remember(
      must("POST", "/v1/catalogs/products", { name: "PlayCount Budget", type: "SERVICE", category: "SOFTWARE" }).then((j) => String(j.id)),
      () => (product = undefined),
    ));
  const planId = (amountCents: number) => {
    let plan = plans.get(amountCents);
    if (!plan) {
      const value = decimal(amountCents);
      plan = remember(
        productId().then((product_id) =>
          must("POST", "/v1/billing/plans", {
            product_id,
            name: `PlayCount Budget $${value}/month`,
            billing_cycles: [
              {
                frequency: { interval_unit: "MONTH", interval_count: 1 },
                tenure_type: "REGULAR",
                sequence: 1,
                total_cycles: 0,
                pricing_scheme: { fixed_price: { value, currency_code: "USD" } },
              },
            ],
            payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
          }).then((j) => String(j.id)),
        ),
        () => plans.delete(amountCents),
      );
      plans.set(amountCents, plan);
    }
    return plan;
  };

  return {
    async createSubscription({ amountCents, developerId, returnUrl, cancelUrl }) {
      const sub = await must("POST", "/v1/billing/subscriptions", {
        plan_id: await planId(amountCents),
        custom_id: developerId,
        application_context: { brand_name: "PlayCount", user_action: "SUBSCRIBE_NOW", shipping_preference: "NO_SHIPPING", return_url: returnUrl, cancel_url: cancelUrl },
      });
      const links = (sub.links ?? []) as { rel?: string; href?: string }[];
      const approveUrl = links.find((l) => l.rel === "approve")?.href;
      if (typeof sub.id !== "string" || !approveUrl) throw new Error("PayPal created a Subscription without an approve link");
      return { id: sub.id, approveUrl };
    },

    async subscription(id) {
      if (!isSubscriptionId(id)) return undefined;
      const res = await call("GET", `/v1/billing/subscriptions/${id}`);
      if (res.status === 404) return undefined;
      if (!res.ok || !res.json) throw new Error(`PayPal GET subscription answered ${res.status}`);
      const { status, plan_id, custom_id } = res.json;
      // The price lives on the Plan, so it is read from there rather than trusted from the browser.
      const plan = (await must("GET", `/v1/billing/plans/${encodeURIComponent(String(plan_id))}`)) as Plan;
      const price = plan.billing_cycles?.find((c) => c.tenure_type === "REGULAR")?.pricing_scheme?.fixed_price;
      const amountCents = price?.currency_code === "USD" ? centsOf(price.value) : undefined;
      if (amountCents === undefined) throw new Error(`PayPal Plan ${plan_id} is not priced in USD`);
      return {
        id,
        status: status as SubscriptionStatus,
        amountCents,
        developerId: typeof custom_id === "string" ? custom_id : "",
      };
    },

    async sendPayouts({ senderBatchId, items }) {
      const res = await call("POST", "/v1/payments/payouts", {
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          email_subject: "You have a royalty from PlayCount",
          email_message: "Developers' AI coding agents relied on your project. PlayCount pays it a royalty from their monthly budgets.",
        },
        items: items.map((item, i) => ({
          recipient_type: "EMAIL",
          receiver: item.receiver,
          amount: { value: decimal(item.amountCents), currency: "USD" },
          note: item.note,
          sender_item_id: senderItemId(senderBatchId, i),
        })),
      });
      const batchId = (res.json?.batch_header as { payout_batch_id?: unknown } | undefined)?.payout_batch_id;
      if (res.status === 201 && typeof batchId === "string") return { payoutBatchId: batchId };
      // Sent before (say the first answer was lost): PayPal refuses it and links the batch it has.
      const details = (res.json?.details ?? []) as { field?: string; link?: { href?: string }[] }[];
      const existing = details.find((d) => d.field === "SENDER_BATCH_ID")?.link?.[0]?.href?.match(/\/payouts\/([A-Z0-9]+)$/)?.[1];
      if (res.status === 400 && existing) return { payoutBatchId: existing };
      throw new Error(`PayPal POST /v1/payments/payouts answered ${res.status}: ${JSON.stringify(res.json)}`);
    },

    async payoutBatch(payoutBatchId) {
      const items: PayoutItemState[] = [];
      let status = "PENDING";
      for (let page = 1, pages = 1; page <= pages; page++) {
        const json = await must("GET", `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}?page=${page}&page_size=1000&total_required=true`);
        // With total_required, PayPal answers total_pages (checked against the sandbox).
        pages = typeof json.total_pages === "number" ? json.total_pages : 1;
        status = String((json.batch_header as { batch_status?: unknown } | undefined)?.batch_status ?? status);
        for (const item of (json.items ?? []) as BatchItem[]) {
          const id = item.payout_item?.sender_item_id;
          const fee = item.payout_item_fee?.currency === "USD" ? centsOf(item.payout_item_fee.value) : 0;
          if (typeof id !== "string" || typeof item.transaction_status !== "string") continue;
          items.push({ senderItemId: id, payoutItemId: item.payout_item_id, status: item.transaction_status as PayoutItemStatus, feeCents: fee ?? 0 });
        }
      }
      return { status: status as PayoutBatchStatus, items };
    },
  };
}

type BatchItem = {
  payout_item_id?: string;
  transaction_status?: string;
  payout_item_fee?: { value?: string; currency?: string };
  payout_item?: { sender_item_id?: string };
};

export type FakePayPal = PayPal & {
  // What the Developer does on PayPal's approve page.
  approve(id: string): void;
  // PayPal has taken the payment and activated the Subscription.
  activate(id: string): void;
  cancel(id: string): void;
  // The Subscriptions created so far, newest last, with the return and cancel links they were given.
  created: (Subscription & { returnUrl: string; cancelUrl: string })[];
  // The Payouts batches PayPal has accepted, oldest first.
  payouts: (PayoutBatch & { payoutBatchId: string })[];
  // PayPal moves the latest payout to the Project to this status.
  finish(project: string, status: PayoutItemStatus): void;
  // PayPal rejects the whole batch: it is DENIED and lists no items.
  deny(payoutBatchId: string): void;
  // How many times PlayCount has read a batch back.
  batchReads: number;
  // The next payoutBatch fails.
  failNextRead(): void;
  // The next sendPayouts fails before PayPal takes the batch.
  failNext(): void;
  // PayPal takes the next batch, but its answer never arrives.
  loseNextAnswer(): void;
};

// A PayPal whose Subscriptions start APPROVAL_PENDING; approve() makes one ACTIVE at once,
// as the sandbox does for SUBSCRIBE_NOW, unless activateLater is set.
export function fakePayPal({ activateLater = false } = {}): FakePayPal {
  const created: FakePayPal["created"] = [];
  const payouts: FakePayPal["payouts"] = [];
  // Item statuses by sender_item_id; an item PayPal has not finished is PENDING.
  const statuses = new Map<string, PayoutItemStatus>();
  let next: "fail" | "lose" | undefined;
  let failRead = false;
  const denied = new Set<string>();
  const find = (id: string) => created.find((s) => s.id === id);
  const set = (id: string, status: SubscriptionStatus) => {
    const sub = find(id);
    if (sub) sub.status = status;
  };
  const fake: FakePayPal = {
    created,
    payouts,
    async createSubscription(sub) {
      const id = `I-FAKE${String(created.length + 1).padStart(8, "0")}`;
      created.push({ id, status: "APPROVAL_PENDING", ...sub });
      return { id, approveUrl: `https://paypal.test/webapps/billing/subscriptions?ba_token=BA-${id}` };
    },
    async subscription(id) {
      const sub = find(id);
      return sub && { id: sub.id, status: sub.status, amountCents: sub.amountCents, developerId: sub.developerId };
    },
    approve: (id) => set(id, activateLater ? "APPROVED" : "ACTIVE"),
    activate: (id) => set(id, "ACTIVE"),
    cancel: (id) => set(id, "CANCELLED"),
    async sendPayouts(batch) {
      const mishap = next;
      next = undefined;
      if (mishap === "fail") throw new Error("PayPal is unreachable");
      let sent = payouts.find((p) => p.senderBatchId === batch.senderBatchId);
      if (!sent) {
        sent = { ...structuredClone(batch), payoutBatchId: `FAKEBATCH${payouts.length + 1}` };
        payouts.push(sent);
      }
      if (mishap === "lose") throw new Error("PayPal's answer was lost");
      return { payoutBatchId: sent.payoutBatchId };
    },
    async payoutBatch(payoutBatchId) {
      fake.batchReads++;
      if (failRead) {
        failRead = false;
        throw new Error("PayPal is unreachable");
      }
      if (denied.has(payoutBatchId)) return { status: "DENIED", items: [] };
      const batch = payouts.find((p) => p.payoutBatchId === payoutBatchId);
      const items = (batch?.items ?? []).map((_, i) => {
        const id = senderItemId(batch!.senderBatchId, i);
        const status = statuses.get(id) ?? "PENDING";
        // As in the sandbox: no fee for a FAILED item, a RETURNED one keeps it.
        return { senderItemId: id, payoutItemId: `FAKEITEM-${id}`, status, feeCents: status === "FAILED" ? 0 : 25 };
      });
      return { status: items.every((i) => i.status !== "PENDING") ? "SUCCESS" : "PROCESSING", items };
    },
    deny: (payoutBatchId) => void denied.add(payoutBatchId),
    finish(project, status) {
      const batch = payouts.findLast((p) => p.items.some((i) => i.project === project));
      if (!batch) throw new Error(`no payout to ${project} was sent`);
      statuses.set(senderItemId(batch.senderBatchId, batch.items.findIndex((i) => i.project === project)), status);
    },
    batchReads: 0,
    failNextRead: () => void (failRead = true),
    failNext: () => void (next = "fail"),
    loseNextAnswer: () => void (next = "lose"),
  };
  return fake;
}
