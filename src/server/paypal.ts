// The PayPal adapter: Subscriptions that fund Developers' Budgets (and, with #11, Payouts to
// Projects). The real one talks to PayPal's REST API; tests use the fake.

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

export interface PayPal {
  // Creates a monthly Subscription awaiting the Developer's approval; returns PayPal's approve link.
  createSubscription(sub: NewSubscription): Promise<{ id: string; approveUrl: string }>;
  // The Subscription as PayPal has it now, or undefined if PayPal has no such Subscription.
  subscription(id: string): Promise<Subscription | undefined>;
}

// PayPal's Subscription ids look like I-3LEKCLHWYE52.
export const isSubscriptionId = (id: string) => /^I-[A-Z0-9]{6,40}$/.test(id);

export const SANDBOX_API = "https://api-m.sandbox.paypal.com";
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
      const value = (amountCents / 100).toFixed(2);
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
      if (price?.currency_code !== "USD" || !price.value) throw new Error(`PayPal Plan ${plan_id} is not priced in USD`);
      return {
        id,
        status: status as SubscriptionStatus,
        amountCents: Math.round(Number(price.value) * 100),
        developerId: typeof custom_id === "string" ? custom_id : "",
      };
    },
  };
}

export type FakePayPal = PayPal & {
  // What the Developer does on PayPal's approve page.
  approve(id: string): void;
  // PayPal has taken the payment and activated the Subscription.
  activate(id: string): void;
  cancel(id: string): void;
  // The Subscriptions created so far, newest last, with the return and cancel links they were given.
  created: (Subscription & { returnUrl: string; cancelUrl: string })[];
};

// A PayPal whose Subscriptions start APPROVAL_PENDING; approve() makes one ACTIVE at once,
// as the sandbox does for SUBSCRIBE_NOW, unless activateLater is set.
export function fakePayPal({ activateLater = false } = {}): FakePayPal {
  const created: FakePayPal["created"] = [];
  const find = (id: string) => created.find((s) => s.id === id);
  const set = (id: string, status: SubscriptionStatus) => {
    const sub = find(id);
    if (sub) sub.status = status;
  };
  return {
    created,
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
  };
}
