import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "./server.ts";
import { inMemoryLedger, type Ledger } from "./ledger.ts";
import { inMemoryDevelopers } from "./developers.ts";
import { fakeGitHub } from "./github.ts";
import { fakePayPal, type FakePayPal } from "./paypal.ts";

const ada = { id: "dev_ada", name: "Ada", key: "pk_ada" };

const play = (project: string, at = "2026-10-21T12:00:00.000Z") => ({ kind: "import", project, lines_written: 3, session_id: "s", at });

let server: RunningServer;
let ledger: Ledger;
let paypal: FakePayPal;
let now: Date;

beforeEach(async () => {
  now = new Date("2026-10-21T18:00:00.000Z");
  ledger = inMemoryLedger();
  paypal = fakePayPal();
  ledger.recordClaim("hono", { payoutEmail: "hono-maintainers@personal.example.com" });
  ledger.recordClaim("zod", { payoutEmail: "zod-maintainers@personal.example.com" });
  server = await startServer({
    ledger,
    developers: inMemoryDevelopers([ada]),
    demoDeveloperId: ada.id,
    github: fakeGitHub({ "code-ada": { id: 1, login: "ada", name: "Ada" } }),
    paypal,
    clock: () => now,
    port: 0,
  });
  ledger.recordBudget(ada.id, { amountCents: 1000, since: "2026-09-01T00:00:00.000Z" });
});
afterEach(() => server.close());

const api = (path: string, init: RequestInit & { key?: string } = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${init.key ?? ada.key}` } });

type Royalty = { project: string; amount_cents: number; status: string; payout?: { status: string; item_id?: string; fee_cents: number } };
type Settlement = {
  status: string;
  spendable_cents: number;
  royalties: Royalty[];
  fees_cents: number;
  sent_cents: number;
  held_cents: number;
  rolled_over_cents: number;
};

// Settles October with hono 60% and zod 40%: two payouts of $5.70 and $3.80, $0.50 in fees.
async function settledTwoPayouts() {
  expect((await api("/api/plays", { method: "POST", body: JSON.stringify({ plays: [play("hono"), play("zod")] }) })).status).toBe(202);
  expect((await api("/api/weighting/propose?period=2026-10", { method: "POST" })).status).toBe(201);
  const shares = [{ project: "hono", share: 60 }, { project: "zod", share: 40 }];
  expect((await api("/api/weighting?period=2026-10", { method: "PUT", body: JSON.stringify({ shares }) })).status).toBe(200);
  expect((await api("/api/weighting/approve?period=2026-10", { method: "POST" })).status).toBe(200);
  const res = await api("/api/settle?period=2026-10", { method: "POST" });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as Settlement;
}

const reconcile = async (period = "2026-10") => {
  const res = await api(`/api/reconcile?period=${period}`, { method: "POST" });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Settlement;
};
const royalty = (s: Settlement, project: string) => s.royalties.find((r) => r.project === project);
const accounted = (s: Settlement) => s.sent_cents + s.held_cents + s.rolled_over_cents + s.fees_cents;

describe("Reconciling a Settlement's payouts", () => {
  it("reads each payout item's status back from PayPal and records it in the Ledger", async () => {
    await settledTwoPayouts();
    paypal.finish("hono", "SUCCESS");

    const s = await reconcile();
    expect(royalty(s, "hono")).toMatchObject({ status: "paid", amount_cents: 570, payout: { status: "SUCCESS", fee_cents: 25 } });
    expect(royalty(s, "hono")?.payout?.item_id).toMatch(/\w+/);
    // zod's payout is still with PayPal.
    expect(royalty(s, "zod")).toMatchObject({ status: "sent", payout: { status: "PENDING" } });
    expect(ledger.settlementOf(ada.id, "2026-10")?.royalties.find((r) => r.project === "hono")?.status).toBe("paid");
    expect(accounted(s)).toBe(1000);
  });
});

describe("A payout PayPal fails or returns", () => {
  it("puts the Royalty back in the Pool, held for its Project, and rolls over the fee PayPal did not charge", async () => {
    await settledTwoPayouts();
    paypal.finish("hono", "SUCCESS");
    paypal.finish("zod", "FAILED");

    const s = await reconcile();
    expect(royalty(s, "zod")).toMatchObject({ status: "returned-held", amount_cents: 380, payout: { status: "FAILED", fee_cents: 0 } });
    expect(s).toMatchObject({ sent_cents: 570, held_cents: 380, fees_cents: 25, rolled_over_cents: 25 });
    expect(accounted(s)).toBe(1000);
  });

  it("holds a RETURNED payout's Royalty; PayPal keeps that fee", async () => {
    await settledTwoPayouts();
    paypal.finish("hono", "SUCCESS");
    paypal.finish("zod", "UNCLAIMED");
    expect(royalty(await reconcile(), "zod")).toMatchObject({ status: "sent", payout: { status: "UNCLAIMED" } });

    paypal.finish("zod", "RETURNED");
    const s = await reconcile();
    expect(royalty(s, "zod")).toMatchObject({ status: "returned-held", payout: { status: "RETURNED", fee_cents: 25 } });
    expect(s).toMatchObject({ sent_cents: 570, held_cents: 380, fees_cents: 50, rolled_over_cents: 0 });
  });

  it("carries the uncharged fee into the Developer's next Settlement", async () => {
    await settledTwoPayouts();
    paypal.finish("hono", "SUCCESS");
    paypal.finish("zod", "FAILED");
    await reconcile();

    now = new Date("2026-11-20T00:00:00.000Z");
    const res = await api("/api/settle?period=2026-11", { method: "POST" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ rollover_in_cents: 25, spendable_cents: 1025 });
  });

  it("holds every Royalty of a batch PayPal rejects outright", async () => {
    const settled = await settledTwoPayouts();
    paypal.deny(paypal.payouts[0].payoutBatchId);
    const s = await reconcile();
    expect(s.royalties.map((r) => [r.status, r.payout?.status])).toEqual([["returned-held", "DENIED"], ["returned-held", "DENIED"]]);
    expect(s).toMatchObject({ sent_cents: 0, held_cents: 950, fees_cents: 0, rolled_over_cents: 50 });
    expect(accounted(s)).toBe(settled.spendable_cents);
  });
});

describe("Re-running reconciliation", () => {
  it("changes nothing and asks PayPal nothing once every status is final", async () => {
    await settledTwoPayouts();
    paypal.finish("hono", "SUCCESS");
    paypal.finish("zod", "FAILED");
    const first = await reconcile();
    const reads = paypal.batchReads;

    // Even if PayPal later reported something else, a final status stays as recorded.
    paypal.finish("zod", "SUCCESS");
    expect(await reconcile()).toEqual(first);
    expect(paypal.batchReads).toBe(reads);
    expect(ledger.settlementOf(ada.id, "2026-10")?.royalties.find((r) => r.project === "zod")?.status).toBe("returned-held");
  });

  it("does not call PayPal for a Settlement that sent no payouts", async () => {
    const res = await api("/api/settle?period=2026-10", { method: "POST" });
    expect(res.status).toBe(201);
    expect(await reconcile()).toMatchObject({ royalties: [], rolled_over_cents: 1000 });
    expect(paypal.batchReads).toBe(0);
  });
});

describe("Reconciliation failures", () => {
  it("is 404 before the period is settled, and needs a known PlayCount key", async () => {
    expect((await api("/api/reconcile?period=2026-10", { method: "POST" })).status).toBe(404);
    expect((await api("/api/reconcile?period=2026-10", { method: "POST", key: "pk_nobody" })).status).toBe(401);
    expect((await api("/api/reconcile?period=2026-13", { method: "POST" })).status).toBe(400);
  });

  it("leaves the Ledger as it was when PayPal does not answer", async () => {
    await settledTwoPayouts();
    paypal.failNextRead();
    expect((await api("/api/reconcile?period=2026-10", { method: "POST" })).status).toBe(502);
    expect(ledger.settlementOf(ada.id, "2026-10")?.royalties.map((r) => r.status)).toEqual(["sent", "sent"]);
    paypal.finish("hono", "SUCCESS");
    expect(royalty(await reconcile(), "hono")?.status).toBe("paid");
  });

  it("refuses a Settlement whose batch PayPal never confirmed", async () => {
    paypal.failNext();
    expect((await api("/api/plays", { method: "POST", body: JSON.stringify({ plays: [play("hono")] }) })).status).toBe(202);
    await api("/api/weighting/propose?period=2026-10", { method: "POST" });
    await api("/api/weighting/approve?period=2026-10", { method: "POST" });
    expect((await api("/api/settle?period=2026-10", { method: "POST" })).status).toBe(502);
    expect((await api("/api/reconcile?period=2026-10", { method: "POST" })).status).toBe(409);
    expect(paypal.batchReads).toBe(0);
  });
});

describe("Reconciling in the background", () => {
  it("reads back payouts PayPal has not finished, without being asked", async () => {
    await server.close();
    server = await startServer({ ledger, developers: inMemoryDevelopers([ada]), paypal, clock: () => now, port: 0, reconcileEveryMs: 10 });
    await settledTwoPayouts();
    paypal.finish("hono", "SUCCESS");
    paypal.finish("zod", "SUCCESS");

    const statuses = () => ledger.settlementOf(ada.id, "2026-10")?.royalties.map((r) => r.status);
    await expect.poll(statuses, { timeout: 2000, interval: 10 }).toEqual(["paid", "paid"]);
    // Once every status is final, PayPal is not asked again.
    const reads = paypal.batchReads;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(paypal.batchReads).toBe(reads);
  });
});

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
      const [name, value] = header.split(";")[0].split("=");
      if (/max-age=0/i.test(header) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
}

const section = (page: string) => page.match(/<section id="settlement">[\s\S]*?<\/section>/)?.[0] ?? "";
const statusOf = (page: string, project: string) => page.match(new RegExp(`data-project="${project}" data-status="([a-z-]+)"`))?.[1];

describe("The dashboard's payouts", () => {
  it("shows what PayPal actually did with each payout", async () => {
    await settledTwoPayouts();
    let page = section(await (await fetch(server.url)).text());
    expect(statusOf(page, "hono")).toBe("sent");

    paypal.finish("hono", "SUCCESS");
    await reconcile();
    page = section(await (await fetch(server.url)).text());
    expect(statusOf(page, "hono")).toBe("paid");
    expect(page).toMatch(/id="settlement-payouts">PayPal is still processing 1 payout/);

    paypal.finish("zod", "RETURNED");
    await reconcile();
    page = section(await (await fetch(server.url)).text());
    expect(statusOf(page, "zod")).toBe("returned-held");
    expect(page).toContain("PayPal says RETURNED");
    expect(page).toMatch(/id="settlement-payouts">PayPal has finished every payout/);
    // A visitor who has not signed in cannot ask PayPal.
    expect(page).not.toContain('action="/reconcile"');
  });

  it("offers the signed-in Developer Check PayPal now while payouts are processing", async () => {
    const b = browser();
    const state = new URL((await b("/auth/github")).headers.get("location")!).searchParams.get("state");
    expect((await b(`/auth/github/callback?code=code-ada&state=${state}`)).status).toBe(302);
    const me = "dev_gh_1";
    ledger.recordBudget(me, { amountCents: 1000, since: "2026-09-01T00:00:00.000Z" });
    ledger.recordPlays(me, [{ kind: "import", project: "hono", session_id: "s", at: "2026-10-21T12:00:00.000Z" }]);
    const form = (path: string) =>
      b(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ period: "2026-10" }) });
    for (const path of ["/weighting/propose", "/weighting/approve", "/settle"]) expect((await form(path)).status).toBe(303);

    expect(section(await (await b("/")).text())).toContain('action="/reconcile"');
    paypal.finish("hono", "SUCCESS");
    const res = await form("/reconcile");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/#settlement");
    const page = section(await (await b("/")).text());
    expect(statusOf(page, "hono")).toBe("paid");
    expect(page).not.toContain('action="/reconcile"');
  });

  it("refuses Check PayPal now from a browser that has not signed in", async () => {
    await settledTwoPayouts();
    const res = await browser()("/reconcile", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "period=2026-10" });
    expect(res.status).toBe(401);
    expect(paypal.batchReads).toBe(0);
  });
});
