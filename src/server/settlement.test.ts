import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "./server.ts";
import { inMemoryLedger, type Ledger } from "./ledger.ts";
import { inMemoryDevelopers } from "./developers.ts";
import { fakeGitHub } from "./github.ts";
import { fakePayPal, type FakePayPal } from "./paypal.ts";

const ada = { id: "dev_ada", name: "Ada", key: "pk_ada" };
const bob = { id: "dev_bob", name: "Bob", key: "pk_bob" };
const HONO_EMAIL = "hono-maintainers@personal.example.com";
const ZOD_EMAIL = "zod-maintainers@personal.example.com";

const play = (project: string, at = "2026-10-21T12:00:00.000Z") => ({ kind: "import", project, lines_written: 3, session_id: "s", at });

let server: RunningServer;
let ledger: Ledger;
let paypal: FakePayPal;
let now: Date;

async function start({ withPayPal = true } = {}) {
  ledger = inMemoryLedger();
  paypal = fakePayPal();
  ledger.recordClaim("hono", { payoutEmail: HONO_EMAIL });
  server = await startServer({
    ledger,
    developers: inMemoryDevelopers([ada, bob]),
    demoDeveloperId: ada.id,
    github: fakeGitHub({ "code-ada": { id: 1, login: "ada", name: "Ada" } }),
    paypal: withPayPal ? paypal : undefined,
    clock: () => now,
    port: 0,
  });
}

beforeEach(async () => {
  now = new Date("2026-10-21T18:00:00.000Z");
  await start();
});
afterEach(() => server.close());

const api = (path: string, init: RequestInit & { key?: string } = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${init.key ?? ada.key}` } });

const budget = (developerId: string, dollars: number, since = "2026-09-01T00:00:00.000Z") =>
  ledger.recordBudget(developerId, { amountCents: dollars * 100, since });

async function postPlays(plays: unknown[], key = ada.key) {
  expect((await api("/api/plays", { method: "POST", body: JSON.stringify({ plays }), key })).status).toBe(202);
}

// Proposes from Play counts (no AI model in these tests), sets the shares and approves.
async function approveWeighting(shares: Record<string, number>, period = "2026-10", key = ada.key) {
  expect((await api(`/api/weighting/propose?period=${period}`, { method: "POST", key })).status).toBe(201);
  const list = Object.entries(shares).map(([project, share]) => ({ project, share }));
  expect((await api(`/api/weighting?period=${period}`, { method: "PUT", body: JSON.stringify({ shares: list }), key })).status).toBe(200);
  expect((await api(`/api/weighting/approve?period=${period}`, { method: "POST", key })).status).toBe(200);
}

type Royalty = { project: string; share: number; amount_cents: number; status: "sent" | "unclaimed-held" | "rolled-over" };
type Settlement = {
  period: string;
  status: string;
  budget_cents: number;
  rollover_in_cents: number;
  spendable_cents: number;
  royalties: Royalty[];
  fees_cents: number;
  payouts: number;
  sent_cents: number;
  held_cents: number;
  rolled_over_cents: number;
  payout_batch_id?: string;
};

const settle = (period = "2026-10", key = ada.key) => api(`/api/settle?period=${period}`, { method: "POST", key });
const settled = async (period = "2026-10", key = ada.key) => {
  const res = await settle(period, key);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as Settlement;
};
const royalty = (s: Settlement, project: string) => s.royalties.find((r) => r.project === project);

// Every cent of the spendable amount is accounted for.
const accounted = (s: Settlement) => s.sent_cents + s.held_cents + s.rolled_over_cents + s.fees_cents;

describe("Settling a period", () => {
  it("turns the approved Weighting into Royalties in integer cents", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono"), play("zod"), play("express")]);
    await approveWeighting({ hono: 50, zod: 33.33, express: 16.67 });

    const s = await settled();
    expect(s).toMatchObject({ period: "2026-10", status: "settled", budget_cents: 1000, rollover_in_cents: 0, spendable_cents: 1000 });
    // hono is claimed, so its $0.25 payout fee is set aside first: $9.75 is split by the Weighting.
    expect(s.fees_cents).toBe(25);
    expect(s.royalties.map((r) => [r.project, r.amount_cents])).toEqual([
      ["hono", 487],
      ["zod", 325],
      ["express", 163],
    ]);
    for (const r of s.royalties) expect(Number.isInteger(r.amount_cents)).toBe(true);
    expect(accounted(s)).toBe(1000);
  });

  it("refuses until the period's Weighting is approved", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono")]);
    expect((await settle()).status).toBe(409);
    await api("/api/weighting/propose?period=2026-10", { method: "POST" });
    const res = await settle();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/approve/i);
    expect(paypal.payouts).toEqual([]);
  });

  it("settles on an auto-approved Weighting", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono")]);
    await api("/api/weighting/propose?period=2026-10", { method: "POST" });
    now = new Date(now.getTime() + 8 * 24 * 3600 * 1000);
    expect((await settled()).royalties).toEqual([{ project: "hono", share: 100, amount_cents: 975, status: "sent" }]);
  });

  it("refuses a Developer without a Budget, a future period and a period before the Budget began", async () => {
    await postPlays([play("hono")]);
    expect((await settle()).status).toBe(422);
    budget(ada.id, 10, "2026-10-05T00:00:00.000Z");
    expect((await settle("2026-11")).status).toBe(422);
    expect((await settle("2026-09")).status).toBe(422);
    expect((await settle("2026-13")).status).toBe(400);
  });

  it("needs a known PlayCount key", async () => {
    expect((await settle("2026-10", "pk_nobody")).status).toBe(401);
  });
});

describe("Payouts", () => {
  it("pays claimed Projects their full Royalty in one Payouts batch, with fees paid from the Pool", async () => {
    ledger.recordClaim("zod", { payoutEmail: ZOD_EMAIL });
    budget(ada.id, 10);
    await postPlays([play("hono"), play("zod")]);
    await approveWeighting({ hono: 60, zod: 40 });

    const s = await settled();
    // Two payout items, $0.50 of fees, leaves $9.50 to split 60/40.
    expect(s.fees_cents).toBe(50);
    expect(s.payouts).toBe(2);
    expect(royalty(s, "hono")).toMatchObject({ amount_cents: 570, status: "sent" });
    expect(royalty(s, "zod")).toMatchObject({ amount_cents: 380, status: "sent" });
    expect(paypal.payouts).toHaveLength(1);
    expect(paypal.payouts[0].items).toEqual([
      expect.objectContaining({ receiver: HONO_EMAIL, amountCents: 570, project: "hono" }),
      expect.objectContaining({ receiver: ZOD_EMAIL, amountCents: 380, project: "zod" }),
    ]);
    expect(s.payout_batch_id).toBe(paypal.payouts[0].payoutBatchId);
    expect(s.sent_cents).toBe(950);
    expect(accounted(s)).toBe(1000);
  });

  it("holds Unclaimed royalties in the Ledger and sends nothing to an unverified address", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono"), play("zod")]);
    await approveWeighting({ hono: 50, zod: 50 });

    const s = await settled();
    expect(royalty(s, "zod")).toMatchObject({ amount_cents: 487, status: "unclaimed-held" });
    expect(s.held_cents).toBe(487);
    expect(paypal.payouts[0].items.map((i) => i.project)).toEqual(["hono"]);
    expect(ledger.settlementOf(ada.id, "2026-10")?.royalties.find((r) => r.project === "zod")?.status).toBe("unclaimed-held");
  });

  it("sends no batch when no Project is claimed", async () => {
    budget(ada.id, 10);
    await postPlays([play("zod")]);
    await approveWeighting({ zod: 100 });
    const s = await settled();
    expect(s).toMatchObject({ fees_cents: 0, payouts: 0, held_cents: 1000 });
    expect(s.payout_batch_id).toBeUndefined();
    expect(paypal.payouts).toEqual([]);
  });

  it("is refused when payouts are due and PayPal is not configured", async () => {
    await server.close();
    await start({ withPayPal: false });
    budget(ada.id, 10);
    await postPlays([play("hono")]);
    await approveWeighting({ hono: 100 });
    expect((await settle()).status).toBe(503);
  });
});

describe("Rollovers", () => {
  it("rolls a Royalty under $1 over to the Developer's next Settlement, with its unused fee", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono"), play("zod")]);
    await approveWeighting({ hono: 95, zod: 5 });

    const oct = await settled();
    // zod's 49¢ is under $1, so it rolls over rather than being held.
    expect(royalty(oct, "zod")).toMatchObject({ amount_cents: 49, status: "rolled-over" });
    expect(royalty(oct, "hono")).toMatchObject({ amount_cents: 926, status: "sent" });
    expect(oct.rolled_over_cents).toBe(49);
    expect(accounted(oct)).toBe(1000);

    now = new Date("2026-11-20T00:00:00.000Z");
    await postPlays([play("hono", "2026-11-10T00:00:00.000Z")]);
    await approveWeighting({ hono: 100 }, "2026-11");
    const nov = await settled("2026-11");
    expect(nov).toMatchObject({ rollover_in_cents: 49, spendable_cents: 1049 });
    expect(royalty(nov, "hono")).toMatchObject({ amount_cents: 1024, status: "sent" });
  });

  it("rolls a claimed Project's Royalty under $1 over together with the fee set aside for it", async () => {
    ledger.recordClaim("zod", { payoutEmail: ZOD_EMAIL });
    budget(ada.id, 10);
    await postPlays([play("hono"), play("zod")]);
    await approveWeighting({ hono: 95, zod: 5 });
    const s = await settled();
    expect(royalty(s, "hono")).toMatchObject({ amount_cents: 903, status: "sent" });
    expect(royalty(s, "zod")).toMatchObject({ amount_cents: 47, status: "rolled-over" });
    // Only hono's payout is sent, so only one fee is paid; zod's set-aside fee rolls over too.
    expect(s).toMatchObject({ payouts: 1, fees_cents: 25, rolled_over_cents: 47 + 25 });
    expect(paypal.payouts[0].items.map((i) => i.project)).toEqual(["hono"]);
    expect(accounted(s)).toBe(1000);
  });

  it("rolls the whole Budget over when the period has no Plays", async () => {
    budget(ada.id, 10);
    const s = await settled();
    expect(s).toMatchObject({ royalties: [], rolled_over_cents: 1000, fees_cents: 0, payouts: 0 });
    expect(paypal.payouts).toEqual([]);

    now = new Date("2026-11-20T00:00:00.000Z");
    expect(await settled("2026-11")).toMatchObject({ rollover_in_cents: 1000, spendable_cents: 2000, rolled_over_cents: 2000 });
  });
});

describe("Settling in order", () => {
  it("refuses a period earlier than one already settled, so a Rollover only moves forward", async () => {
    budget(ada.id, 10);
    now = new Date("2026-11-20T00:00:00.000Z");
    await settled("2026-11");
    const res = await settle("2026-10");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/2026-11 is already settled/);
  });
});

describe("Small Budgets", () => {
  it("rolls everything over when the spendable amount cannot cover the fees set aside", async () => {
    for (const p of ["a", "b", "c", "d", "e"]) ledger.recordClaim(p, { payoutEmail: `${p}@personal.example.com` });
    budget(ada.id, 1);
    await postPlays(["a", "b", "c", "d", "e"].map((p) => play(p)));
    await approveWeighting({ a: 20, b: 20, c: 20, d: 20, e: 20 });
    const s = await settled();
    // Five fees ($1.25) would exceed the $1 Budget, so nothing is paid and every cent rolls over.
    expect(s.royalties.every((r) => r.status === "rolled-over" && r.amount_cents === 0)).toBe(true);
    expect(s).toMatchObject({ payouts: 0, fees_cents: 0, rolled_over_cents: 100 });
    expect(paypal.payouts).toEqual([]);
  });
});

describe("Idempotent Settlement", () => {
  it("never pays a Royalty twice when the same period is settled again", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono")]);
    await approveWeighting({ hono: 100 });
    const first = await settled();

    const again = await settle();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    const [a, b] = await Promise.all([settle(), settle()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(paypal.payouts).toHaveLength(1);
  });

  it("pays once when two Settlements of the same period race", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono")]);
    await approveWeighting({ hono: 100 });
    const statuses = (await Promise.all([settle(), settle()])).map((r) => r.status);
    // One settles; the other finds it still paying (409) or already settled (200).
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200 || s === 409)).toHaveLength(1);
    expect(paypal.payouts).toHaveLength(1);
  });

  it("retries a batch PayPal did not confirm with the same batch id, so PayPal never pays it twice", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono")]);
    await approveWeighting({ hono: 100 });

    // PayPal takes the batch but the answer is lost.
    paypal.loseNextAnswer();
    const failed = await settle();
    expect(failed.status).toBe(502);
    expect((await api("/api/settlement?period=2026-10")).status).toBe(200);
    expect(paypal.payouts).toHaveLength(1);

    const retried = await settle();
    expect(retried.status).toBe(201);
    const s = (await retried.json()) as Settlement;
    expect(s.status).toBe("settled");
    expect(s.payout_batch_id).toBe(paypal.payouts[0].payoutBatchId);
    expect(paypal.payouts).toHaveLength(1);
  });

  it("keeps the first computation when a retry happens after more Plays arrive", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono")]);
    await approveWeighting({ hono: 100 });
    paypal.failNext();
    expect((await settle()).status).toBe(502);
    expect(paypal.payouts).toEqual([]);
    await postPlays([play("zod")]);
    const s = await settled();
    expect(s.royalties.map((r) => r.project)).toEqual(["hono"]);
    expect(paypal.payouts).toHaveLength(1);
  });
});

describe("Each Developer's own Budget", () => {
  it("pays only for the Developer's own Agent's Plays", async () => {
    budget(ada.id, 10);
    budget(bob.id, 20);
    await postPlays([play("hono")]);
    await postPlays([play("zod"), play("zod")], bob.key);
    await approveWeighting({ hono: 100 });
    await approveWeighting({ zod: 100 }, "2026-10", bob.key);

    const a = await settled();
    expect(a.royalties.map((r) => r.project)).toEqual(["hono"]);
    expect(a.spendable_cents).toBe(1000);
    const b = await settled("2026-10", bob.key);
    expect(b.royalties).toEqual([{ project: "zod", share: 100, amount_cents: 2000, status: "unclaimed-held" }]);
    expect(b.spendable_cents).toBe(2000);
  });

  it("does not carry one Developer's Rollover into another's Settlement", async () => {
    budget(ada.id, 10);
    budget(bob.id, 20);
    await settled();
    now = new Date("2026-11-20T00:00:00.000Z");
    expect(await settled("2026-11", bob.key)).toMatchObject({ rollover_in_cents: 0, spendable_cents: 2000 });
    expect(await settled("2026-11")).toMatchObject({ rollover_in_cents: 1000, spendable_cents: 2000 });
  });
});

describe("Reading a Settlement", () => {
  it("is 404 before the period is settled", async () => {
    expect((await api("/api/settlement?period=2026-10")).status).toBe(404);
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

async function signedIn() {
  const b = browser();
  const state = new URL((await b("/auth/github")).headers.get("location")!).searchParams.get("state");
  expect((await b(`/auth/github/callback?code=code-ada&state=${state}`)).status).toBe(302);
  return b;
}
const SIGNED_IN = "dev_gh_1";

const form = (b: ReturnType<typeof browser>, path: string, fields: Record<string, string> = { period: "2026-10" }) =>
  b(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

const section = (page: string) => page.match(/<section id="settlement">[\s\S]*?<\/section>/)?.[0];
const statusOf = (page: string, project: string) => page.match(new RegExp(`data-project="${project}" data-status="([a-z-]+)"`))?.[1];

describe("The dashboard's Settlement", () => {
  it("shows each Royalty's status, the PayPal fees as one line, and what rolled over", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono"), play("zod"), play("express")]);
    await approveWeighting({ hono: 80, zod: 15, express: 5 });
    await settled();

    const page = section(await (await fetch(server.url)).text())!;
    expect(statusOf(page, "hono")).toBe("sent");
    expect(statusOf(page, "zod")).toBe("unclaimed-held");
    expect(statusOf(page, "express")).toBe("rolled-over");
    expect(page).toMatch(/id="settlement-fees">.*1 payout at \$0\.25.*\$0\.25/);
    expect(page).toMatch(/id="settlement-rollover">.*\$0\.49/);
    expect(page).toContain("FAKEBATCH1");
    // A visitor who has not signed in cannot settle the demo Developer's period.
    expect(page).not.toContain('action="/settle"');
  });

  it("offers the signed-in Developer Settle now, once the Weighting is approved", async () => {
    const b = await signedIn();
    budget(SIGNED_IN, 10);
    ledger.recordPlays(SIGNED_IN, [{ kind: "import", project: "hono", session_id: "s", at: "2026-10-21T12:00:00.000Z" }]);
    expect(section(await (await b("/")).text())).toMatch(/<button type="submit" class="primary" disabled>Settle now/);

    expect((await form(b, "/weighting/propose")).status).toBe(303);
    expect((await form(b, "/weighting/approve")).status).toBe(303);
    expect(section(await (await b("/")).text())).toMatch(/<button type="submit" class="primary">Settle now/);

    const res = await form(b, "/settle");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/#settlement");
    expect(statusOf(section(await (await b("/")).text())!, "hono")).toBe("sent");
    expect(paypal.payouts).toHaveLength(1);
  });

  it("refuses Settle now from a browser that has not signed in", async () => {
    budget(ada.id, 10);
    expect((await form(browser(), "/settle")).status).toBe(401);
    expect(ledger.settlementOf(ada.id, "2026-10")).toBeUndefined();
  });

  it("keeps payout addresses off the page and out of the API", async () => {
    budget(ada.id, 10);
    await postPlays([play("hono")]);
    await approveWeighting({ hono: 100 });
    expect(JSON.stringify(await settled())).not.toContain(HONO_EMAIL);
    expect(await (await fetch(server.url)).text()).not.toContain(HONO_EMAIL);
  });
});
