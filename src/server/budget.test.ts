import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "./server.ts";
import { inMemoryLedger, type Ledger } from "./ledger.ts";
import { inMemoryDevelopers } from "./developers.ts";
import { fakeGitHub } from "./github.ts";
import { fakePayPal, type FakePayPal } from "./paypal.ts";

const demo = { id: "dev_demo", name: "Demo developer", key: "pk_demo" };
const ada = { id: 101, login: "ada", name: "Ada Lovelace" };
const grace = { id: 202, login: "grace", name: "Grace Hopper" };
const ADA = "dev_gh_101";
const PUBLIC_URL = "https://playcount.test";
const NOW = "2026-10-21T18:00:00.000Z";

let server: RunningServer;
let ledger: Ledger;
let paypal: FakePayPal;

async function start(opts: { paypal?: FakePayPal | false } = {}) {
  ledger = inMemoryLedger();
  paypal = opts.paypal || fakePayPal();
  server = await startServer({
    ledger,
    developers: inMemoryDevelopers([demo]),
    demoDeveloperId: demo.id,
    github: fakeGitHub({ "code-ada": ada, "code-grace": grace }),
    paypal: opts.paypal === false ? undefined : paypal,
    publicUrl: PUBLIC_URL,
    clock: () => new Date(NOW),
    port: 0,
  });
}

beforeEach(() => start());
afterEach(() => server.close());

// A browser: keeps cookies between requests and does not follow redirects, so tests see them.
function browser() {
  const jar = new Map<string, string>();
  return async (path: string, init: RequestInit = {}) => {
    const res = await fetch(new URL(path, server.url), {
      ...init,
      redirect: "manual",
      headers: { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const [name, value] = pair.split("=");
      if (/max-age=0/i.test(header) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
}

type Browser = ReturnType<typeof browser>;

async function signedIn(code = "code-ada") {
  const b = browser();
  const state = new URL((await b("/auth/github")).headers.get("location")!).searchParams.get("state");
  expect((await b(`/auth/github/callback?code=${code}&state=${state}`)).status).toBe(302);
  return b;
}

const chooseBudget = (b: Browser, amount: string) =>
  b("/budget", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ amount }),
  });

// Where PayPal sends the browser back after the Developer approves on PayPal's page.
const returnFromPayPal = (b: Browser, id: string) => b(`/budget/return?subscription_id=${id}&ba_token=BA-x`);

async function dashboard(b: Browser) {
  const res = await b("/");
  expect(res.status).toBe(200);
  return res.text();
}

const budgetOn = (page: string) => page.match(/id="budget-amount">([^<]+)</)?.[1];

describe("Choosing a Budget", () => {
  it("offers a monthly Budget form with $10 as the default", async () => {
    const page = await dashboard(await signedIn());
    expect(page).toMatch(/<form method="post" action="\/budget"/);
    expect(page).toMatch(/name="amount"[^>]*value="10"/);
    expect(budgetOn(page)).toBeUndefined();
  });

  it("creates a Subscription for the amount and sends the browser to PayPal's approve link", async () => {
    const b = await signedIn();
    const res = await chooseBudget(b, "25");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://paypal.test/webapps/billing/subscriptions?ba_token=BA-I-FAKE00000001");
    expect(paypal.created).toEqual([
      expect.objectContaining({
        amountCents: 2500,
        developerId: ADA,
        returnUrl: `${PUBLIC_URL}/budget/return`,
        cancelUrl: `${PUBLIC_URL}/budget/cancel`,
      }),
    ]);
  });

  it("accepts dollars and cents", async () => {
    expect((await chooseBudget(await signedIn(), "12.50")).status).toBe(303);
    expect(paypal.created[0].amountCents).toBe(1250);
  });

  it("refuses an amount that is not a dollar amount between $1 and $1000", async () => {
    const b = await signedIn();
    for (const amount of ["", "0", "0.99", "-5", "abc", "10.555", "1000.01", "1e3"]) {
      expect((await chooseBudget(b, amount)).status, amount).toBe(400);
    }
    expect(paypal.created).toEqual([]);
  });

  it("is refused without a signed-in Developer", async () => {
    expect((await chooseBudget(browser(), "10")).status).toBe(401);
    expect(paypal.created).toEqual([]);
  });

  it("is off, with no form, when PayPal is not configured", async () => {
    await server.close();
    await start({ paypal: false });
    const b = await signedIn();
    expect(await dashboard(b)).not.toContain('action="/budget"');
    expect((await chooseBudget(b, "10")).status).toBe(503);
  });
});

describe("Returning from PayPal", () => {
  it("records the Budget once the Subscription is ACTIVE, and the dashboard shows it", async () => {
    const b = await signedIn();
    await chooseBudget(b, "10");
    const { id } = paypal.created[0];
    paypal.approve(id);

    const res = await returnFromPayPal(b, id);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(ledger.budgetOf(ADA)).toEqual({ amountCents: 1000, subscriptionId: id, since: NOW });

    const page = await dashboard(b);
    expect(budgetOn(page)).toBe("$10.00");
    expect(page).toContain(id);
    expect(page).not.toContain('action="/budget"');
  });

  it("records the Budget only once when the return link is opened again", async () => {
    const b = await signedIn();
    await chooseBudget(b, "10");
    const { id } = paypal.created[0];
    paypal.approve(id);
    await returnFromPayPal(b, id);
    const first = ledger.budgetOf(ADA);
    expect((await returnFromPayPal(b, id)).status).toBe(303);
    expect(ledger.budgetOf(ADA)).toBe(first);
  });

  it("records nothing for a Subscription the Developer has not approved", async () => {
    const b = await signedIn();
    await chooseBudget(b, "10");
    const res = await returnFromPayPal(b, paypal.created[0].id);
    expect(res.status).toBe(402);
    expect(await res.text()).toMatch(/not approved/i);
    expect(ledger.budgetOf(ADA)).toBeUndefined();
    expect(budgetOn(await dashboard(b))).toBeUndefined();
  });

  it("records nothing when the Developer cancels on PayPal's page", async () => {
    const b = await signedIn();
    await chooseBudget(b, "10");
    const { id } = paypal.created[0];
    const res = await b(`/budget/cancel?subscription_id=${id}&ba_token=BA-x&token=x`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    paypal.cancel(id);
    expect((await returnFromPayPal(b, id)).status).toBe(402);
    expect(ledger.budgetOf(ADA)).toBeUndefined();
    expect(await dashboard(b)).toContain('action="/budget"');
  });

  it("waits for an approved Subscription PayPal has not activated yet, then records it", async () => {
    await server.close();
    await start({ paypal: fakePayPal({ activateLater: true }) });
    const b = await signedIn();
    await chooseBudget(b, "10");
    const { id } = paypal.created[0];
    paypal.approve(id);

    const waiting = await returnFromPayPal(b, id);
    expect(waiting.status).toBe(202);
    expect(await waiting.text()).toMatch(/activating/i);
    expect(ledger.budgetOf(ADA)).toBeUndefined();

    paypal.activate(id);
    expect((await returnFromPayPal(b, id)).status).toBe(303);
    expect(ledger.budgetOf(ADA)?.amountCents).toBe(1000);
  });

  it("does not record another Developer's Subscription", async () => {
    const g = await signedIn("code-grace");
    await chooseBudget(g, "10");
    const { id } = paypal.created[0];
    paypal.approve(id);

    const a = await signedIn();
    expect((await returnFromPayPal(a, id)).status).toBe(403);
    expect(ledger.budgetOf(ADA)).toBeUndefined();
  });

  it("refuses a Subscription PayPal does not know, or a malformed id", async () => {
    const b = await signedIn();
    for (const id of ["I-UNKNOWN0001", "../v1/x", ""]) {
      expect((await returnFromPayPal(b, id)).status, id).toBe(400);
    }
    expect(ledger.budgetOf(ADA)).toBeUndefined();
  });

  it("asks a browser that is not signed in to sign in", async () => {
    await chooseBudget(await signedIn(), "10");
    const { id } = paypal.created[0];
    paypal.approve(id);
    expect((await returnFromPayPal(browser(), id)).status).toBe(401);
  });
});

describe("When PayPal fails", () => {
  const down = (): FakePayPal => {
    const fake = fakePayPal();
    return { ...fake, createSubscription: () => Promise.reject(new Error("down")), subscription: () => Promise.reject(new Error("down")) };
  };

  it("says so instead of sending the browser anywhere", async () => {
    await server.close();
    await start({ paypal: down() });
    expect((await chooseBudget(await signedIn(), "10")).status).toBe(502);
  });

  it("records nothing when the Subscription cannot be read on return", async () => {
    await server.close();
    await start({ paypal: down() });
    const b = await signedIn();
    expect((await returnFromPayPal(b, "I-3LEKCLHWYE52")).status).toBe(502);
    expect(ledger.budgetOf(ADA)).toBeUndefined();
  });
});

describe("A Developer with an active Budget", () => {
  it("cannot start a second Subscription", async () => {
    const b = await signedIn();
    await chooseBudget(b, "10");
    paypal.approve(paypal.created[0].id);
    await returnFromPayPal(b, paypal.created[0].id);
    expect((await chooseBudget(b, "20")).status).toBe(409);
    expect(paypal.created).toHaveLength(1);
  });

  it("keeps their Budget separate from other Developers'", async () => {
    const b = await signedIn();
    await chooseBudget(b, "10");
    paypal.approve(paypal.created[0].id);
    await returnFromPayPal(b, paypal.created[0].id);
    expect(ledger.budgetOf("dev_gh_202")).toBeUndefined();
    expect(budgetOn(await dashboard(await signedIn("code-grace")))).toBeUndefined();
  });
});

describe("Signed-out dashboard", () => {
  it("shows the demo Developer's seeded Budget, labelled as seeded, and no form", async () => {
    ledger.recordBudget(demo.id, { amountCents: 1000, since: NOW });
    const page = await dashboard(browser());
    expect(budgetOn(page)).toBe("$10.00");
    expect(page).toMatch(/seeded/i);
    expect(page).not.toContain('action="/budget"');
  });
});
