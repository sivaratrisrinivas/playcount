import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "./server.ts";
import { inMemoryLedger, type Ledger } from "./ledger.ts";
import { inMemoryDevelopers } from "./developers.ts";
import { fakeGitHub } from "./github.ts";
import { fakeWeigher, type Weigher, type WeigherInput } from "./weigher.ts";

const ada = { id: "dev_ada", name: "Ada", key: "pk_ada" };
const bob = { id: "dev_bob", name: "Bob", key: "pk_bob" };
const DAY = 24 * 3600 * 1000;

const play = (project: string, extra: Record<string, unknown> = {}) => ({
  kind: "import",
  project,
  lines_written: 3,
  file_ext: "ts",
  session_id: "secret-session-id",
  at: "2026-10-21T12:00:00.000Z",
  ...extra,
});

let server: RunningServer;
let ledger: Ledger;
let now: Date;
let weigher: ReturnType<typeof fakeWeigher>;

async function start({ weigher: w }: { weigher?: Weigher } = { weigher }) {
  ledger = inMemoryLedger();
  server = await startServer({
    ledger,
    developers: inMemoryDevelopers([ada, bob]),
    demoDeveloperId: ada.id,
    weigher: w,
    github: fakeGitHub({ "code-grace": { id: 7, login: "grace", name: "Grace" } }),
    clock: () => now,
    port: 0,
  });
}

beforeEach(async () => {
  now = new Date("2026-10-21T18:00:00.000Z");
  weigher = fakeWeigher();
  await start();
});

afterEach(() => server.close());

const api = (path: string, init: RequestInit & { key?: string } = {}) =>
  fetch(`${server.url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${init.key ?? ada.key}` },
  });

async function postPlays(plays: unknown[], key = ada.key) {
  const res = await api("/api/plays", { method: "POST", body: JSON.stringify({ plays }), key });
  expect(res.status).toBe(202);
}

const propose = (query = "?period=2026-10", key = ada.key) => api(`/api/weighting/propose${query}`, { method: "POST", key });
const getWeighting = (query = "?period=2026-10", key = ada.key) => api(`/api/weighting${query}`, { key });
const adjust = (shares: unknown, query = "?period=2026-10") =>
  api(`/api/weighting${query}`, { method: "PUT", body: JSON.stringify({ shares }) });
const approve = (query = "?period=2026-10") => api(`/api/weighting/approve${query}`, { method: "POST" });

type Share = { project: string; share: number; reason: string };
const sharesOf = async (res: Response) => ((await res.json()) as { shares: Share[] }).shares;

describe("Proposing a Weighting", () => {
  it("covers every played Project, sums to 100% and gives a one-line reason per Project", async () => {
    await postPlays([play("zod", { lines_written: 30 }), play("express", { lines_written: 10 }), { kind: "docs", project: "hono", session_id: "s", at: "2026-10-02T00:00:00.000Z" }]);
    const res = await propose();
    expect(res.status).toBe(201);
    const weighting = await res.json();
    expect(weighting).toMatchObject({ period: "2026-10", status: "proposed", proposed_by: "claude", proposed_at: now.toISOString() });
    const shares: Share[] = weighting.shares;
    expect(shares.map((s) => s.project).sort()).toEqual(["express", "hono", "zod"]);
    expect(Math.round(shares.reduce((sum, s) => sum + s.share * 100, 0))).toBe(10000);
    for (const s of shares) expect(s.reason).toMatch(/^[^\n]+$/);
  });

  it("turns Claude's weights into percentages that still sum to exactly 100%", async () => {
    weigher.respond(({ projects }) => projects.map((p) => ({ project: p.project, weight: 1, reason: `Used ${p.project}` })));
    await postPlays([play("a"), play("b"), play("c")]);
    const shares = await sharesOf(await propose());
    expect(shares.map((s) => s.share).sort()).toEqual([33.33, 33.33, 33.34]);
    expect(shares.find((s) => s.project === "a")?.reason).toBe("Used a");
  });

  it("sends the Weigher Play-log fields only: no session ids, file types, times or anything else (ADR 0001)", async () => {
    await postPlays([play("zod", { lines_written: 4 }), { kind: "docs", project: "zod", session_id: "s", at: "2026-10-03T00:00:00.000Z" }]);
    await propose();
    expect(weigher.calls).toEqual<WeigherInput[]>([
      { period: "2026-10", projects: [{ project: "zod", import_plays: 1, docs_plays: 1, lines_written: 4 }] },
    ]);
  });

  it("weighs only the Developer's own Plays in that period", async () => {
    await postPlays([play("zod"), play("express", { at: "2026-09-30T00:00:00.000Z" })]);
    await postPlays([play("left-pad")], bob.key);
    const shares = await sharesOf(await propose());
    expect(shares.map((s) => s.project)).toEqual(["zod"]);
  });

  it("falls back to a Weighting by Plays when Claude cannot be reached, and says so", async () => {
    weigher.respond(() => {
      throw new Error("gateway down");
    });
    await postPlays([play("zod", { lines_written: 8 }), play("express", { lines_written: 0 })]);
    const res = await propose();
    expect(res.status).toBe(201);
    const weighting = await res.json();
    expect(weighting.proposed_by).toBe("play counts");
    expect(weighting.shares).toEqual([
      { project: "zod", share: 90, reason: "1 import Play, 0 docs Plays, 8 lines written" },
      { project: "express", share: 10, reason: "1 import Play, 0 docs Plays, 0 lines written" },
    ]);
  });

  it("falls back when Claude's answer leaves out a played Project", async () => {
    weigher.respond(() => [{ project: "zod", weight: 1, reason: "Core" }]);
    await postPlays([play("zod"), play("express")]);
    const weighting = await (await propose()).json();
    expect(weighting.proposed_by).toBe("play counts");
    expect(weighting.shares.map((s: Share) => s.project).sort()).toEqual(["express", "zod"]);
  });

  it("falls back when no Weigher is configured", async () => {
    await server.close();
    await start({});
    await postPlays([play("zod")]);
    const weighting = await (await propose()).json();
    expect(weighting).toMatchObject({ proposed_by: "play counts", shares: [{ project: "zod", share: 100 }] });
  });

  it("keeps each reason to one short line", async () => {
    weigher.respond(() => [{ project: "zod", weight: 1, reason: `  Schema validation\n everywhere ${"x".repeat(300)}` }]);
    await postPlays([play("zod")]);
    const [share] = await sharesOf(await propose());
    expect(share.reason.startsWith("Schema validation everywhere x")).toBe(true);
    expect(share.reason).not.toContain("\n");
    expect(share.reason.length).toBeLessThanOrEqual(160);
  });

  it("can be proposed again before approval, picking up newly played Projects", async () => {
    await postPlays([play("zod")]);
    await propose();
    await postPlays([play("express")]);
    const shares = await sharesOf(await propose());
    expect(shares.map((s) => s.project).sort()).toEqual(["express", "zod"]);
  });

  it("is refused for a period with no Plays", async () => {
    const res = await propose("?period=2026-08");
    expect(res.status).toBe(422);
    expect(weigher.calls).toEqual([]);
  });

  it("defaults to the current period", async () => {
    await postPlays([play("zod")]);
    expect(await (await propose("")).json()).toMatchObject({ period: "2026-10" });
  });

  it("rejects a missing or wrong PlayCount key and a malformed period", async () => {
    expect((await propose("?period=2026-10", "pk_nobody")).status).toBe(401);
    expect((await propose("?period=2026-13")).status).toBe(400);
  });
});

describe("Reading a Weighting", () => {
  it("returns the proposal", async () => {
    await postPlays([play("zod")]);
    const proposed = await (await propose()).json();
    const res = await getWeighting();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(proposed);
  });

  it("is not found before one is proposed, and is the Developer's own", async () => {
    expect((await getWeighting()).status).toBe(404);
    await postPlays([play("zod")]);
    await propose();
    expect((await getWeighting("?period=2026-10", bob.key)).status).toBe(404);
  });
});

describe("Adjusting a Weighting", () => {
  beforeEach(async () => {
    await postPlays([play("zod"), play("express")]);
    await propose();
  });

  it("replaces the shares and keeps Claude's reasons", async () => {
    const before = await sharesOf(await getWeighting());
    const res = await adjust([{ project: "zod", share: 72.5 }, { project: "express", share: 27.5 }]);
    expect(res.status).toBe(200);
    const weighting = await res.json();
    expect(weighting).toMatchObject({ status: "proposed", adjusted: true });
    expect(weighting.shares).toEqual([
      { project: "zod", share: 72.5, reason: before.find((s) => s.project === "zod")!.reason },
      { project: "express", share: 27.5, reason: before.find((s) => s.project === "express")!.reason },
    ]);
    expect(await sharesOf(await getWeighting())).toEqual(weighting.shares);
  });

  it.each([
    { name: "shares that sum to less than 100%", shares: [{ project: "zod", share: 50 }, { project: "express", share: 40 }] },
    { name: "shares that sum to more than 100%", shares: [{ project: "zod", share: 60.01 }, { project: "express", share: 40 }] },
    { name: "a negative share", shares: [{ project: "zod", share: 110 }, { project: "express", share: -10 }] },
    { name: "a share finer than 0.01%", shares: [{ project: "zod", share: 50.005 }, { project: "express", share: 49.995 }] },
    { name: "a played Project left out", shares: [{ project: "zod", share: 100 }] },
    { name: "a Project that was not played", shares: [{ project: "zod", share: 50 }, { project: "express", share: 40 }, { project: "lodash", share: 10 }] },
    { name: "a Project listed twice", shares: [{ project: "zod", share: 50 }, { project: "zod", share: 50 }] },
    { name: "a share that is not a number", shares: [{ project: "zod", share: "50" }, { project: "express", share: 50 }] },
    { name: "a body that is not a list of shares", shares: { zod: 100 } },
  ])("rejects $name and keeps the proposal", async ({ shares }) => {
    const before = await (await getWeighting()).json();
    const res = await adjust(shares);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
    expect(await (await getWeighting()).json()).toEqual(before);
  });

  it("is not found when nothing was proposed for the period", async () => {
    expect((await adjust([{ project: "zod", share: 100 }], "?period=2026-09")).status).toBe(404);
  });

  it("is not lost to a proposal Claude was still weighing when it was saved", async () => {
    let release = () => {};
    weigher.respond(async ({ projects }) => {
      await new Promise<void>((resolve) => (release = resolve));
      return projects.map((p) => ({ project: p.project, weight: 1, reason: "Late" }));
    });
    const proposing = propose();
    await expect.poll(() => weigher.calls.length).toBe(2);
    expect((await adjust([{ project: "zod", share: 99 }, { project: "express", share: 1 }])).status).toBe(200);
    release();
    expect((await proposing).status).toBe(409);
    expect(await sharesOf(await getWeighting())).toMatchObject([{ project: "zod", share: 99 }, { project: "express", share: 1 }]);
  });
});

describe("Approving a Weighting", () => {
  beforeEach(async () => {
    await postPlays([play("zod"), play("express")]);
    await propose();
  });

  it("locks the Weighting for that period", async () => {
    await adjust([{ project: "zod", share: 80 }, { project: "express", share: 20 }]);
    now = new Date("2026-10-22T09:00:00.000Z");
    const res = await approve();
    expect(res.status).toBe(200);
    const approved = await res.json();
    expect(approved).toMatchObject({ status: "approved", approved_by: "developer", approved_at: now.toISOString() });

    expect((await adjust([{ project: "zod", share: 50 }, { project: "express", share: 50 }])).status).toBe(409);
    expect((await propose()).status).toBe(409);
    expect((await approve()).status).toBe(409);
    expect(await (await getWeighting()).json()).toEqual(approved);
  });

  it("is not found when nothing was proposed for the period", async () => {
    expect((await approve("?period=2026-09")).status).toBe(404);
  });
});

describe("Auto-approval", () => {
  beforeEach(async () => {
    await postPlays([play("zod"), play("express")]);
    await propose();
  });

  it("does not happen before 7 days have passed since the proposal", async () => {
    now = new Date(now.getTime() + 7 * DAY - 1);
    expect(await (await getWeighting()).json()).toMatchObject({ status: "proposed", auto_approves_at: "2026-10-28T18:00:00.000Z" });
    expect((await adjust([{ project: "zod", share: 1 }, { project: "express", share: 99 }])).status).toBe(200);
  });

  it("approves a Weighting 7 days after it was proposed, as it stood then", async () => {
    await adjust([{ project: "zod", share: 65 }, { project: "express", share: 35 }]);
    now = new Date(now.getTime() + 9 * DAY);
    const weighting = await (await getWeighting()).json();
    expect(weighting).toMatchObject({ status: "approved", approved_by: "auto", approved_at: "2026-10-28T18:00:00.000Z" });
    expect(weighting.shares.map((s: Share) => s.share)).toEqual([65, 35]);
  });

  it("locks the Weighting even if the Developer never reads it first", async () => {
    now = new Date(now.getTime() + 7 * DAY);
    expect((await adjust([{ project: "zod", share: 50 }, { project: "express", share: 50 }])).status).toBe(409);
    expect((await approve()).status).toBe(409);
    expect(ledger.weightingOf(ada.id, "2026-10")).toMatchObject({ status: "approved", approved_by: "auto" });
  });

  it("counts from the first proposal, so proposing again cannot put it off", async () => {
    now = new Date(now.getTime() + 6 * DAY);
    const again = await (await propose()).json();
    expect(again.auto_approves_at).toBe("2026-10-28T18:00:00.000Z");
    now = new Date(now.getTime() + 1 * DAY);
    expect(await (await getWeighting()).json()).toMatchObject({ status: "approved", approved_by: "auto" });
  });
});

// A browser that keeps cookies and does not follow redirects, signed in as Grace through the fake GitHub.
async function signedInBrowser() {
  const jar = new Map<string, string>();
  const b = async (path: string, init: RequestInit = {}) => {
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
  const start = await b("/auth/github");
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  await b(`/auth/github/callback?code=code-grace&state=${state}`);
  const page = async () => (await b("/")).text();
  const key = (await page()).match(/id="key">(pk_[\w-]+)</)![1];
  const form = (path: string, fields: [string, string][]) => b(path, { method: "POST", body: new URLSearchParams(fields) });
  return { page, key, form };
}

describe("Dashboard Weighting", () => {
  it("offers the signed-in Developer a proposal once there are Plays", async () => {
    const grace = await signedInBrowser();
    expect(await grace.page()).not.toContain('action="/weighting/propose"');
    await postPlays([play("zod")], grace.key);
    expect(await grace.page()).toContain('action="/weighting/propose"');
  });

  it("proposes, adjusts and approves from the dashboard", async () => {
    weigher.respond(({ projects }) => projects.map((p) => ({ project: p.project, weight: 1, reason: `Reason for ${p.project}` })));
    const grace = await signedInBrowser();
    await postPlays([play("zod"), play("express")], grace.key);

    const proposed = await grace.form("/weighting/propose", [["period", "2026-10"]]);
    expect(proposed.status).toBe(303);
    let html = await grace.page();
    expect(html).toContain("Reason for zod");
    expect(html).toContain("Reason for express");
    expect(html).toContain('action="/weighting/adjust"');
    expect(html).toContain('action="/weighting/approve"');
    expect(html).toContain("2026-10-28");

    const adjusted = await grace.form("/weighting/adjust", [["period", "2026-10"], ["project", "zod"], ["share", "70"], ["project", "express"], ["share", "30"]]);
    expect(adjusted.status).toBe(303);
    expect(await sharesOf(await getWeighting("?period=2026-10", grace.key))).toMatchObject([{ project: "zod", share: 70 }, { project: "express", share: 30 }]);

    expect((await grace.form("/weighting/approve", [["period", "2026-10"]])).status).toBe(303);
    html = await grace.page();
    expect(html).toContain("Approved");
    expect(html).toContain("70%");
    expect(html).not.toContain('action="/weighting/adjust"');
    expect(html).not.toContain('action="/weighting/approve"');
  });

  it("refuses an adjustment from the dashboard that does not sum to 100%", async () => {
    const grace = await signedInBrowser();
    await postPlays([play("zod"), play("express")], grace.key);
    await grace.form("/weighting/propose", [["period", "2026-10"]]);
    const res = await grace.form("/weighting/adjust", [["period", "2026-10"], ["project", "zod"], ["share", "70"], ["project", "express"], ["share", "20"]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/100%/);
  });

  it("says when the proposal came from Play counts because Claude was unavailable", async () => {
    weigher.respond(() => {
      throw new Error("down");
    });
    const grace = await signedInBrowser();
    await postPlays([play("zod")], grace.key);
    await grace.form("/weighting/propose", [["period", "2026-10"]]);
    expect(await grace.page()).toContain("Claude was unavailable");
  });

  it("shows a visitor who has not signed in the demo Developer's Weighting, read-only", async () => {
    weigher.respond(({ projects }) => projects.map((p) => ({ project: p.project, weight: 1, reason: `Reason for ${p.project}` })));
    await postPlays([play("zod")]);
    expect(await (await fetch(`${server.url}/`)).text()).not.toContain('action="/weighting/propose"');
    await propose();
    const html = await (await fetch(`${server.url}/`)).text();
    expect(html).toContain("Reason for zod");
    expect(html).not.toContain('action="/weighting/adjust"');
    expect(html).not.toContain('action="/weighting/approve"');
  });

  it("does not let a visitor who has not signed in change the demo Developer's Weighting", async () => {
    await postPlays([play("zod")]);
    await propose();
    const post = (path: string) => fetch(`${server.url}${path}`, { method: "POST", body: new URLSearchParams([["period", "2026-10"]]), redirect: "manual" });
    expect((await post("/weighting/approve")).status).toBe(401);
    expect((await post("/weighting/propose")).status).toBe(401);
    expect(await (await getWeighting()).json()).toMatchObject({ status: "proposed" });
  });
});
