import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "./server.ts";
import { inMemoryLedger, type Ledger } from "./ledger.ts";
import { inMemoryDevelopers } from "./developers.ts";
import { fakeGitHub } from "./github.ts";
import { fakeNpm, type NpmPackage } from "./npm.ts";
import { fakePayPal, type FakePayPal } from "./paypal.ts";

const ada = { id: "dev_ada", name: "Ada", key: "pk_ada" };
const bob = { id: "dev_bob", name: "Bob", key: "pk_bob" };
const HONO_EMAIL = "hono-maintainers@personal.example.com";
const ZOD_EMAIL = "zod-maintainers@personal.example.com";

// Maintainers who sign in with GitHub, and the repos each can push to.
const colin = { id: 31, login: "colinhacks", name: "Colin" };
const mallory = { id: 66, login: "mallory", name: null };
const PUSH = { colinhacks: ["colinhacks/zod", "colinhacks/no-repo-pkg"], mallory: ["mallory/zod-fork"] };

// npm's `repository` field in the shapes real packages use.
const PACKAGES: Record<string, NpmPackage> = {
  zod: { repository: { type: "git", url: "git+https://github.com/colinhacks/zod.git" } },
  "@colin/utils": { repository: "github:colinhacks/zod" },
  "zod-ssh": { repository: { type: "git", url: "git+ssh://git@github.com/ColinHacks/Zod.git" } },
  "zod-short": { repository: "colinhacks/zod" },
  "no-repo-pkg": {},
  "gitlab-pkg": { repository: { type: "git", url: "git+https://gitlab.com/colinhacks/zod.git" } },
};

const play = (project: string, at = "2026-10-21T12:00:00.000Z") => ({ kind: "import", project, lines_written: 3, session_id: "s", at });

let server: RunningServer;
let ledger: Ledger;
let paypal: FakePayPal;
let now: Date;

async function start({ npmUp = true } = {}) {
  ledger = inMemoryLedger();
  paypal = fakePayPal();
  ledger.recordClaim("hono", { payoutEmail: HONO_EMAIL });
  server = await startServer({
    ledger,
    developers: inMemoryDevelopers([ada, bob]),
    demoDeveloperId: ada.id,
    github: fakeGitHub({ "code-colin": colin, "code-mallory": mallory }, PUSH),
    npm: npmUp
      ? fakeNpm(PACKAGES)
      : {
          packageOf: async () => {
            throw new Error("npm is down");
          },
        },
    paypal,
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

async function signIn(b: Browser, code: string, next?: string) {
  const start = await b(`/auth/github${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  return b(`/auth/github/callback?code=${code}&state=${state}`);
}

async function maintainer(code = "code-colin") {
  const b = browser();
  await signIn(b, code);
  return b;
}

const claim = (b: Browser, project: string, payoutEmail = ZOD_EMAIL) =>
  b(`/projects/${project}/claim`, { method: "POST", body: new URLSearchParams({ payout_email: payoutEmail }) });

const view = async (project: string) => {
  const res = await fetch(`${server.url}/api/projects/${project}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { project: string; held_cents: number; claimed: boolean; claimed_by?: string };
};

const budget = (developerId: string, dollars: number) =>
  ledger.recordBudget(developerId, { amountCents: dollars * 100, since: "2026-09-01T00:00:00.000Z" });

async function postPlays(plays: unknown[], key = ada.key) {
  expect((await api("/api/plays", { method: "POST", body: JSON.stringify({ plays }), key })).status).toBe(202);
}

async function approveWeighting(shares: Record<string, number>, period: string, key = ada.key) {
  expect((await api(`/api/weighting/propose?period=${period}`, { method: "POST", key })).status).toBe(201);
  const list = Object.entries(shares).map(([project, share]) => ({ project, share }));
  expect((await api(`/api/weighting?period=${period}`, { method: "PUT", body: JSON.stringify({ shares: list }), key })).status).toBe(200);
  expect((await api(`/api/weighting/approve?period=${period}`, { method: "POST", key })).status).toBe(200);
}

type Settlement = {
  status: string;
  spendable_cents: number;
  royalties: { project: string; amount_cents: number; status: string }[];
  releases: { project: string; amount_cents: number; status: string }[];
  released_cents: number;
  payouts: number;
  fees_cents: number;
  sent_cents: number;
  held_cents: number;
  rolled_over_cents: number;
};

async function settled(period: string, key = ada.key) {
  const res = await api(`/api/settle?period=${period}`, { method: "POST", key });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as Settlement;
}

// Settles October for the Developer with a 50/50 Weighting: hono is paid, zod is held.
async function octoberHoldsZod(key = ada.key) {
  await postPlays([play("hono"), play("zod")], key);
  await approveWeighting({ hono: 50, zod: 50 }, "2026-10", key);
  const s = await settled("2026-10", key);
  expect(s.royalties.find((r) => r.project === "zod")?.status).toBe("unclaimed-held");
  return s;
}

const heldZod = (s: Settlement) => s.royalties.find((r) => r.project === "zod")!.amount_cents;

describe("A Project's public page", () => {
  it("shows the Unclaimed royalties held for it across every Developer", async () => {
    budget(ada.id, 10);
    budget(bob.id, 20);
    const a = heldZod(await octoberHoldsZod(ada.key));
    const b = heldZod(await octoberHoldsZod(bob.key));

    expect(await view("zod")).toEqual({ project: "zod", held_cents: a + b, simulated_held_cents: 0, claimed: false });
    const page = await fetch(`${server.url}/projects/zod`);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain(`$${((a + b) / 100).toFixed(2)}`);
    expect(text).toMatch(/Claim/);
  });

  it("shows nothing held for a Project no Settlement held anything for, and 404s on a name that is no Project", async () => {
    expect(await view("left-pad")).toEqual({ project: "left-pad", held_cents: 0, simulated_held_cents: 0, claimed: false });
    expect((await fetch(`${server.url}/api/projects/@colin/utils`)).status).toBe(200);
    expect((await fetch(`${server.url}/api/projects/not%20a%20name`)).status).toBe(404);
  });

  it("never shows a claimed Project's payout email", async () => {
    const res = await fetch(`${server.url}/api/projects/hono`);
    expect(await res.json()).toEqual({ project: "hono", held_cents: 0, simulated_held_cents: 0, claimed: true });
    expect(await (await fetch(`${server.url}/projects/hono`)).text()).not.toContain(HONO_EMAIL);
  });

  it("links the dashboard's held royalties to their Project pages", async () => {
    budget(ada.id, 10);
    await octoberHoldsZod();
    expect(await (await fetch(`${server.url}/`)).text()).toContain(`href="/projects/zod"`);
  });
});

describe("Claiming a Project", () => {
  it("succeeds for a GitHub user with push access to the repo in the npm repository field", async () => {
    const b = await maintainer();
    const res = await claim(b, "zod");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/projects/zod");
    expect(ledger.claimOf("zod")).toMatchObject({ payoutEmail: ZOD_EMAIL, claimedBy: "colinhacks" });
    expect(await view("zod")).toMatchObject({ claimed: true, claimed_by: "colinhacks" });
    expect(await (await b("/projects/zod")).text()).toMatch(/claimed by colinhacks/i);
  });

  it("reads every shape of the repository field npm uses, scoped names included", async () => {
    const b = await maintainer();
    for (const project of ["@colin/utils", "zod-ssh", "zod-short"]) {
      const res = await claim(b, project);
      expect(res.status, `${project}: ${await res.clone().text()}`).toBe(303);
      expect(ledger.claimOf(project)?.payoutEmail).toBe(ZOD_EMAIL);
    }
  });

  it("fails clearly when the user lacks push access", async () => {
    const res = await claim(await maintainer("code-mallory"), "zod");
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/GitHub user mallory cannot push to github\.com\/colinhacks\/zod/);
    expect(ledger.claimOf("zod")).toBeUndefined();
  });

  it("fails clearly when the package names no GitHub repository, or npm has no such package", async () => {
    const b = await maintainer();
    for (const project of ["no-repo-pkg", "gitlab-pkg"]) {
      const res = await claim(b, project);
      expect(res.status).toBe(422);
      expect(await res.text()).toMatch(/names no GitHub repo/);
      expect(ledger.claimOf(project)).toBeUndefined();
    }
    const missing = await claim(b, "never-published");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toMatch(/no npm package named never-published/);
  });

  it("says so when npm does not answer", async () => {
    await server.close();
    await start({ npmUp: false });
    const res = await claim(await maintainer(), "zod");
    expect(res.status).toBe(502);
    expect(ledger.claimOf("zod")).toBeUndefined();
  });

  it("needs a signed-in GitHub user and a payout email", async () => {
    expect((await claim(browser(), "zod")).status).toBe(401);
    const res = await claim(await maintainer(), "zod", "not-an-email");
    expect(res.status).toBe(400);
    expect(ledger.claimOf("zod")).toBeUndefined();
  });

  it("stores one PayPal email per Project: a claimed Project cannot be claimed again", async () => {
    const colinBrowser = await maintainer();
    expect((await claim(colinBrowser, "zod")).status).toBe(303);
    const again = await claim(colinBrowser, "zod", "someone-else@personal.example.com");
    expect(again.status).toBe(409);
    expect(await again.text()).toMatch(/already claimed/);
    expect(ledger.claimOf("zod")?.payoutEmail).toBe(ZOD_EMAIL);
    expect((await claim(await maintainer(), "hono", "thief@personal.example.com")).status).toBe(409);
    expect(ledger.claimOf("hono")?.payoutEmail).toBe(HONO_EMAIL);
  });

  it("returns the maintainer to the Project page after signing in from it", async () => {
    const b = browser();
    const res = await signIn(b, "code-colin", "/projects/zod");
    expect(res.headers.get("location")).toBe("/projects/zod");
    expect(await (await b("/projects/zod")).text()).toContain(`action="/projects/zod/claim"`);
  });

  it("never returns a sign-in to another site", async () => {
    const res = await signIn(browser(), "code-colin", "https://evil.test/projects/zod");
    expect(res.headers.get("location")).toBe("/");
    const res2 = await signIn(browser(), "code-colin", "//evil.test/projects/zod");
    expect(res2.headers.get("location")).toBe("/");
  });
});

describe("Paying held royalties after a Claim", () => {
  it("pays them in the Developer's first Settlement after the Claim, with the fee from the Pool", async () => {
    budget(ada.id, 10);
    const october = await octoberHoldsZod();
    const held = heldZod(october);
    expect((await claim(await maintainer(), "zod")).status).toBe(303);

    now = new Date("2026-11-20T18:00:00.000Z");
    await postPlays([play("hono", "2026-11-10T12:00:00.000Z")]);
    await approveWeighting({ hono: 100 }, "2026-11");
    const november = await settled("2026-11");

    expect(november.releases).toEqual([{ project: "zod", amount_cents: held, status: "sent" }]);
    expect(november.released_cents).toBe(held);
    // Two payout items now, hono's and zod's, so $0.50 of November's $10 is set aside for fees.
    expect(november.fees_cents).toBe(50);
    expect(november.royalties).toEqual([{ project: "hono", share: 100, amount_cents: 950, status: "sent" }]);
    expect(november.sent_cents + november.held_cents + november.rolled_over_cents + november.fees_cents).toBe(november.spendable_cents);

    const batch = paypal.payouts.at(-1)!;
    expect(batch.items.find((i) => i.project === "zod")).toMatchObject({ receiver: ZOD_EMAIL, amountCents: held });
    expect(batch.items.find((i) => i.project === "zod")!.note).toMatch(/AI coding agents/);
    expect(await view("zod")).toMatchObject({ held_cents: 0, claimed: true });
  });

  it("pays each held royalty once: not again on a repeat or a later Settlement", async () => {
    budget(ada.id, 10);
    await octoberHoldsZod();
    await claim(await maintainer(), "zod");

    now = new Date("2026-11-20T18:00:00.000Z");
    const november = await settled("2026-11");
    expect(november.releases).toHaveLength(1);
    const batches = paypal.payouts.length;
    expect((await api("/api/settle?period=2026-11", { method: "POST" })).status).toBe(200);
    expect(paypal.payouts).toHaveLength(batches);

    now = new Date("2026-12-20T18:00:00.000Z");
    const december = await settled("2026-12");
    expect(december.releases).toEqual([]);
    expect(paypal.payouts).toHaveLength(batches);
  });

  it("shows them held until PayPal confirms the batch that pays them, and a retry pays them once", async () => {
    budget(ada.id, 10);
    const held = heldZod(await octoberHoldsZod());
    await claim(await maintainer(), "zod");

    now = new Date("2026-11-20T18:00:00.000Z");
    paypal.failNext();
    expect((await api("/api/settle?period=2026-11", { method: "POST" })).status).toBe(502);
    expect(await view("zod")).toMatchObject({ held_cents: held });

    const retried = await settled("2026-11");
    expect(retried.releases).toEqual([{ project: "zod", amount_cents: held, status: "sent" }]);
    expect(paypal.payouts.filter((b) => b.items.some((i) => i.project === "zod" && i.amountCents === held))).toHaveLength(1);
    expect(await view("zod")).toMatchObject({ held_cents: 0 });
  });

  it("pays them even in a period with no Plays", async () => {
    budget(ada.id, 10);
    const held = heldZod(await octoberHoldsZod());
    await claim(await maintainer(), "zod");

    now = new Date("2026-11-20T18:00:00.000Z");
    const november = await settled("2026-11");
    expect(november.releases).toEqual([{ project: "zod", amount_cents: held, status: "sent" }]);
    expect(november.fees_cents).toBe(25);
    expect(november.rolled_over_cents).toBe(1000 - 25);
    expect(paypal.payouts.at(-1)!.items).toEqual([expect.objectContaining({ project: "zod", amountCents: held })]);
  });

  it("sends one payout item, and one fee, when the claimed Project is paid this period too", async () => {
    budget(ada.id, 10);
    const held = heldZod(await octoberHoldsZod());
    await claim(await maintainer(), "zod");

    now = new Date("2026-11-20T18:00:00.000Z");
    await postPlays([play("zod", "2026-11-10T12:00:00.000Z")]);
    await approveWeighting({ zod: 100 }, "2026-11");
    const november = await settled("2026-11");

    expect(november.fees_cents).toBe(25);
    expect(november.royalties).toEqual([{ project: "zod", share: 100, amount_cents: 975, status: "sent" }]);
    expect(paypal.payouts.at(-1)!.items).toEqual([expect.objectContaining({ project: "zod", receiver: ZOD_EMAIL, amountCents: 975 + held })]);
  });

  it("pays each Developer's own held royalties in their own next Settlement", async () => {
    budget(ada.id, 10);
    budget(bob.id, 20);
    const adaHeld = heldZod(await octoberHoldsZod(ada.key));
    const bobHeld = heldZod(await octoberHoldsZod(bob.key));
    await claim(await maintainer(), "zod");

    now = new Date("2026-11-20T18:00:00.000Z");
    expect((await settled("2026-11", ada.key)).released_cents).toBe(adaHeld);
    expect(await view("zod")).toMatchObject({ held_cents: bobHeld });
    expect((await settled("2026-11", bob.key)).released_cents).toBe(bobHeld);
    expect(await view("zod")).toMatchObject({ held_cents: 0 });
  });

  it("never pays a simulated Developer's held royalties: they are shown apart and released without money", async () => {
    ledger.recordBudget(bob.id, { amountCents: 1000, since: "2026-09-01T00:00:00.000Z", simulated: true });
    const held = heldZod(await octoberHoldsZod(bob.key));
    expect(await view("zod")).toMatchObject({ held_cents: 0, simulated_held_cents: held });
    expect(await (await fetch(`${server.url}/projects/zod`)).text()).toMatch(/simulated Budgets/);
    await claim(await maintainer(), "zod");

    now = new Date("2026-11-20T18:00:00.000Z");
    const batches = paypal.payouts.length;
    const november = await settled("2026-11", bob.key);
    expect(november.releases).toEqual([{ project: "zod", amount_cents: held, status: "simulated" }]);
    expect(november.fees_cents).toBe(0);
    expect(paypal.payouts).toHaveLength(batches);
    expect(await view("zod")).toMatchObject({ simulated_held_cents: 0 });
  });

  it("keeps a royalty held while it is unclaimed", async () => {
    budget(ada.id, 10);
    const held = heldZod(await octoberHoldsZod());
    now = new Date("2026-11-20T18:00:00.000Z");
    expect((await settled("2026-11")).releases).toEqual([]);
    expect(await view("zod")).toMatchObject({ held_cents: held, claimed: false });
  });
});
