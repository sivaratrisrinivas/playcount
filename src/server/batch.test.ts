import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "./server.ts";
import { inMemoryLedger, type Ledger } from "./ledger.ts";
import { inMemoryDevelopers, type Developer } from "./developers.ts";
import { fakePayPal, type FakePayPal } from "./paypal.ts";
import { simulatedDevelopers } from "./simulated.ts";

const ada = { id: "dev_ada", name: "Ada", key: "pk_ada" };
const bob = { id: "dev_bob", name: "Bob", key: "pk_bob" };
const cy = { id: "dev_cy", name: "Cy", key: "pk_cy" };
const HONO_EMAIL = "hono-maintainers@personal.example.com";
const DAY = 24 * 3600 * 1000;

const play = (project: string, at = "2026-10-21T12:00:00.000Z") => ({ kind: "import", project, lines_written: 3, session_id: "s", at });

let server: RunningServer | undefined;
let ledger: Ledger;
let paypal: FakePayPal;
let now: Date;

async function start(developers: Developer[] = [ada, bob, cy]) {
  server = await startServer({ ledger, developers: inMemoryDevelopers(developers), paypal, clock: () => now, port: 0 });
}

beforeEach(() => {
  now = new Date("2026-10-21T18:00:00.000Z");
  ledger = inMemoryLedger();
  paypal = fakePayPal();
  ledger.recordClaim("hono", { payoutEmail: HONO_EMAIL });
});
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const api = (path: string, key: string, init: RequestInit = {}) =>
  fetch(`${server!.url}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${key}` } });

const budget = (developerId: string, dollars: number, since = "2026-10-01T00:00:00.000Z") =>
  ledger.recordBudget(developerId, { amountCents: dollars * 100, since });

async function postPlays(key: string, plays: unknown[]) {
  expect((await api("/api/plays", key, { method: "POST", body: JSON.stringify({ plays }) })).status).toBe(202);
}

async function approve(key: string, period = "2026-10") {
  expect((await api(`/api/weighting/propose?period=${period}`, key, { method: "POST" })).status).toBe(201);
  expect((await api(`/api/weighting/approve?period=${period}`, key, { method: "POST" })).status).toBe(200);
}

const settlement = async (key: string, period = "2026-10") => {
  const res = await api(`/api/settlement?period=${period}`, key);
  return res.status === 200 ? await res.json() : undefined;
};

describe("The monthly batch", () => {
  beforeEach(() => start());

  it("settles the period that just ended for every Developer with a Budget", async () => {
    budget(ada.id, 10);
    budget(bob.id, 20);
    await postPlays(ada.key, [play("hono")]);
    await approve(ada.key);
    // Bob's Agent played nothing, so his whole Budget rolls over.

    now = new Date("2026-11-01T00:30:00.000Z");
    await server!.runMonthlyBatch();

    expect(await settlement(ada.key)).toMatchObject({ status: "settled", sent_cents: 975 });
    expect(await settlement(bob.key)).toMatchObject({ status: "settled", rolled_over_cents: 2000 });
    // Cy has no Budget, so there is nothing to settle.
    expect(await settlement(cy.key)).toBeUndefined();
    expect(paypal.payouts).toHaveLength(1);
  });

  it("never settles the period still under way", async () => {
    budget(ada.id, 10);
    await postPlays(ada.key, [play("hono")]);
    await approve(ada.key);

    await server!.runMonthlyBatch();
    expect(await settlement(ada.key)).toBeUndefined();
    expect(paypal.payouts).toEqual([]);
  });

  it("proposes a missing Weighting and settles once it is approved or auto-approves", async () => {
    budget(ada.id, 10);
    budget(bob.id, 10);
    await postPlays(ada.key, [play("hono")]);
    await postPlays(bob.key, [play("hono")]);

    now = new Date("2026-11-01T00:30:00.000Z");
    await server!.runMonthlyBatch();
    const proposed = await (await api("/api/weighting?period=2026-10", ada.key)).json();
    expect(proposed.status).toBe("proposed");
    expect(await settlement(ada.key)).toBeUndefined();

    // Ada approves; Bob does nothing and his Weighting auto-approves 7 days after it was proposed.
    expect((await api("/api/weighting/approve?period=2026-10", ada.key, { method: "POST" })).status).toBe(200);
    await server!.runMonthlyBatch();
    expect(await settlement(ada.key)).toMatchObject({ status: "settled" });
    expect(await settlement(bob.key)).toBeUndefined();

    now = new Date(now.getTime() + 8 * DAY);
    await server!.runMonthlyBatch();
    expect(await settlement(bob.key)).toMatchObject({ status: "settled" });
  });

  it("pays each period once however often it runs", async () => {
    budget(ada.id, 10);
    await postPlays(ada.key, [play("hono")]);
    await approve(ada.key);

    now = new Date("2026-11-01T00:30:00.000Z");
    await Promise.all([server!.runMonthlyBatch(), server!.runMonthlyBatch()]);
    await server!.runMonthlyBatch();
    expect(paypal.payouts).toHaveLength(1);
  });

  it("is idempotent with settle now, whichever runs first", async () => {
    budget(ada.id, 10);
    budget(bob.id, 10);
    await postPlays(ada.key, [play("hono")]);
    await postPlays(bob.key, [play("hono")]);
    await approve(ada.key);
    await approve(bob.key);

    // Ada settles now, before the period ends; the batch then leaves her period alone.
    const now1 = await api("/api/settle?period=2026-10", ada.key, { method: "POST" });
    expect(now1.status).toBe(201);
    const { id } = await now1.json();

    now = new Date("2026-11-01T00:30:00.000Z");
    await server!.runMonthlyBatch();
    expect((await settlement(ada.key)).id).toBe(id);
    expect(paypal.payouts).toHaveLength(2);

    // Bob was settled by the batch; settling now returns the same Settlement and pays nothing more.
    const bobs = await settlement(bob.key);
    const again = await api("/api/settle?period=2026-10", bob.key, { method: "POST" });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(bobs.id);
    expect(paypal.payouts).toHaveLength(2);
  });

  it("settles a missed earlier period first, in order", async () => {
    budget(ada.id, 10, "2026-09-01T00:00:00.000Z");
    await postPlays(ada.key, [play("hono", "2026-09-10T12:00:00.000Z"), play("hono", "2026-10-10T12:00:00.000Z")]);
    await approve(ada.key, "2026-09");
    await approve(ada.key, "2026-10");

    now = new Date("2026-11-02T00:00:00.000Z");
    await server!.runMonthlyBatch();
    expect(await settlement(ada.key, "2026-09")).toMatchObject({ status: "settled" });
    expect(await settlement(ada.key, "2026-10")).toMatchObject({ status: "settled" });
  });

  it("retries a Settlement whose payouts PayPal did not confirm", async () => {
    budget(ada.id, 10);
    await postPlays(ada.key, [play("hono")]);
    await approve(ada.key);

    now = new Date("2026-11-01T00:30:00.000Z");
    paypal.failNext();
    await server!.runMonthlyBatch();
    expect(await settlement(ada.key)).toMatchObject({ status: "payout-failed" });
    await server!.runMonthlyBatch();
    expect(await settlement(ada.key)).toMatchObject({ status: "settled" });
    expect(paypal.payouts).toHaveLength(1);
  });

  it("goes on to the next Developer when one Settlement fails", async () => {
    budget(ada.id, 10);
    budget(bob.id, 10);
    await postPlays(ada.key, [play("hono")]);
    await postPlays(bob.key, [play("hono")]);
    await approve(ada.key);
    await approve(bob.key);

    now = new Date("2026-11-01T00:30:00.000Z");
    paypal.failNext();
    await server!.runMonthlyBatch();
    const statuses = [(await settlement(ada.key)).status, (await settlement(bob.key)).status].sort();
    expect(statuses).toEqual(["payout-failed", "settled"]);
  });
});

describe("Simulated Developers", () => {
  const seeded = () => simulatedDevelopers({ ledger, count: 4, now });

  it("are seeded with Budgets and realistic Plays since the start of last period", () => {
    const sims = seeded();
    expect(sims).toHaveLength(4);
    expect(new Set(sims.map((d) => d.id)).size).toBe(4);
    for (const dev of sims) {
      const budget = ledger.budgetOf(dev.id);
      expect(budget?.amountCents).toBeGreaterThanOrEqual(100);
      const plays = ledger.playsOf(dev.id);
      expect(plays.length).toBeGreaterThan(10);
      expect(plays.every((p) => p.at >= "2026-09-01" && Date.parse(p.at) <= now.getTime())).toBe(true);
      expect(plays.some((p) => p.at.startsWith("2026-09")) && plays.some((p) => p.at.startsWith("2026-10"))).toBe(true);
      expect(plays.some((p) => p.kind === "import") && plays.some((p) => p.kind === "docs")).toBe(true);
      expect(new Set(plays.map((p) => p.project)).size).toBeGreaterThan(2);
      // In the order they were played, like a real Agent's Play log.
      expect(plays.map((p) => p.at)).toEqual(plays.map((p) => p.at).sort());
    }
    // Different Agents rely on different Projects.
    const stacks = sims.map((d) => [...new Set(ledger.playsOf(d.id).map((p) => p.project))].sort().join());
    expect(new Set(stacks).size).toBeGreaterThan(1);
  });

  it("are labelled as simulated, and so are their Budgets", () => {
    for (const dev of seeded()) {
      expect(dev.simulated).toBe(true);
      expect(dev.name).toMatch(/\(simulated\)$/);
      expect(ledger.budgetOf(dev.id)?.simulated).toBe(true);
    }
  });

  it("are settled by the monthly batch as soon as the service starts, labelled as simulated", async () => {
    const sims = seeded();
    await start(sims);

    await server!.runMonthlyBatch();
    for (const dev of sims) {
      const s = await settlement(dev.key, "2026-09");
      expect(s).toMatchObject({ status: "settled", simulated: true });
      // hono is the one claimed Project here, so its Royalty is the simulated amount.
      expect(s.simulated_cents).toBe(s.royalties.find((r: { project: string; status: string }) => r.project === "hono" && r.status === "simulated")?.amount_cents ?? 0);
      expect(s.sent_cents + s.held_cents + s.rolled_over_cents + s.fees_cents + s.simulated_cents).toBe(s.spendable_cents);
      const weighting = await (await api("/api/weighting?period=2026-09", dev.key)).json();
      expect(weighting).toMatchObject({ status: "approved", approved_by: "simulated" });
      // The period still under way is left alone.
      expect(await settlement(dev.key)).toBeUndefined();
    }
  });

  it("never send money: a simulated Budget collects none, so its claimed Royalties are only recorded", async () => {
    const sims = seeded();
    await start(sims);

    await server!.runMonthlyBatch();
    expect(paypal.payouts).toEqual([]);
    const hono = (await Promise.all(sims.map((d) => settlement(d.key, "2026-09"))))
      .flatMap((s) => s.royalties)
      .filter((r: { project: string }) => r.project === "hono");
    expect(hono.length).toBeGreaterThan(1);
    for (const r of hono) expect(r.status).toBe("simulated");
  });

  it("each pay only for their own Plays", async () => {
    const sims = seeded();
    await start(sims);

    now = new Date("2026-11-01T00:30:00.000Z");
    await server!.runMonthlyBatch();
    for (const dev of sims) {
      const s = await settlement(dev.key);
      const played = new Set(ledger.playsOf(dev.id).filter((p) => p.at.startsWith("2026-10")).map((p) => p.project));
      expect(s.budget_cents).toBe(ledger.budgetOf(dev.id)!.amountCents);
      expect(s.royalties.map((r: { project: string }) => r.project).sort()).toEqual([...played].sort());
    }
  });

  it("leave a real Developer's Settlement unlabelled", async () => {
    budget(ada.id, 10);
    await start([ada]);
    await postPlays(ada.key, [play("hono")]);
    await approve(ada.key);
    expect((await api("/api/settle", ada.key, { method: "POST" })).status).toBe(201);
    expect((await settlement(ada.key)).simulated).toBeUndefined();
    expect((await settlement(ada.key)).royalties[0].status).toBe("sent");
  });
});
