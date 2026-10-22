import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "./server.ts";
import { inMemoryLedger, type Ledger } from "./ledger.ts";
import { inMemoryDevelopers } from "./developers.ts";
import { fakeGitHub } from "./github.ts";

const demo = { id: "dev_demo", name: "Demo developer", key: "pk_demo" };
const ada = { id: 101, login: "ada", name: "Ada Lovelace" };
const grace = { id: 202, login: "grace", name: null };
const PUBLIC_URL = "https://playcount.test";

const play = (project: string) => ({
  kind: "import",
  project,
  lines_written: 3,
  file_ext: "ts",
  session_id: "s1",
  at: "2026-10-21T12:00:00.000Z",
});

let server: RunningServer;
let ledger: Ledger;

async function start(opts: { github?: boolean } = {}) {
  ledger = inMemoryLedger();
  server = await startServer({
    ledger,
    developers: inMemoryDevelopers([demo]),
    demoDeveloperId: demo.id,
    github: opts.github === false ? undefined : fakeGitHub({ "code-ada": ada, "code-ada-again": ada, "code-grace": grace }),
    publicUrl: PUBLIC_URL,
    clock: () => new Date("2026-10-21T18:00:00.000Z"),
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

// Signs in through the GitHub OAuth flow with the fake GitHub's code.
async function signIn(b: Browser, code: string) {
  const start = await b("/auth/github");
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  return b(`/auth/github/callback?code=${code}&state=${state}`);
}

const keyOn = (page: string) => page.match(/id="key">(pk_[\w-]+)</)?.[1];

async function dashboard(b: Browser) {
  const res = await b("/");
  expect(res.status).toBe(200);
  return res.text();
}

function postPlays(key: string) {
  return fetch(`${server.url}/api/plays`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ plays: [play("zod")] }),
  });
}

describe("GitHub sign-in", () => {
  it("sends the browser to GitHub with a state and PlayCount's callback", async () => {
    const res = await browser()("/auth/github");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe("https://github.test");
    expect(to.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/auth/github/callback`);
    expect(to.searchParams.get("state")).toMatch(/^[\w-]{16,}$/);
  });

  it("creates a Developer for a new GitHub user and signs them in", async () => {
    const b = browser();
    const res = await signIn(b, "code-ada");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const page = await dashboard(b);
    expect(page).toContain("Ada Lovelace");
    expect(keyOn(page)).toMatch(/^pk_[\w-]{20,}$/);
  });

  it("names a Developer by their GitHub login when they have no display name", async () => {
    const b = browser();
    await signIn(b, "code-grace");
    expect(await dashboard(b)).toContain("grace");
  });

  it("finds the same Developer when they sign in again", async () => {
    const first = browser();
    await signIn(first, "code-ada");
    const again = browser();
    await signIn(again, "code-ada-again");
    expect(keyOn(await dashboard(again))).toBe(keyOn(await dashboard(first)));
  });

  it("gives different GitHub users different Developers and keys", async () => {
    const a = browser();
    await signIn(a, "code-ada");
    const g = browser();
    await signIn(g, "code-grace");
    expect(keyOn(await dashboard(a))).not.toBe(keyOn(await dashboard(g)));
  });

  it("rejects a callback whose state is not the one this browser was given", async () => {
    const b = browser();
    await b("/auth/github");
    const res = await b("/auth/github/callback?code=code-ada&state=forged-state-value");
    expect(res.status).toBe(400);
    expect(keyOn(await dashboard(b))).toBeUndefined();
  });

  it("rejects a code GitHub does not accept", async () => {
    const b = browser();
    const res = await signIn(b, "code-unknown");
    expect(res.status).toBe(401);
    expect(keyOn(await dashboard(b))).toBeUndefined();
  });

  it("signs out", async () => {
    const b = browser();
    await signIn(b, "code-ada");
    const res = await b("/auth/signout", { method: "POST" });
    expect(res.status).toBe(303);
    const page = await dashboard(b);
    expect(keyOn(page)).toBeUndefined();
    expect(page).toContain("Sign in with GitHub");
  });

  it("explains that sign-in is off when GitHub is not configured", async () => {
    await server.close();
    await start({ github: false });
    const res = await browser()("/auth/github");
    expect(res.status).toBe(503);
    expect(await dashboard(browser())).not.toContain('href="/auth/github"');
  });
});

describe("Signed-out dashboard", () => {
  it("shows the seeded demo Developer's Plays and offers sign-in", async () => {
    await postPlays(demo.key);
    const page = await dashboard(browser());
    expect(page).toContain("Demo developer");
    expect(page).toContain("<td>zod</td>");
    expect(page).toContain('href="/auth/github"');
    expect(keyOn(page)).toBeUndefined();
  });
});

describe("Signed-in Developer's dashboard", () => {
  it("shows their own Plays, sent with their PlayCount key, and not the demo Developer's", async () => {
    const b = browser();
    await signIn(b, "code-ada");
    const key = keyOn(await dashboard(b))!;
    expect((await postPlays(key)).status).toBe(202);
    await postPlays(demo.key);

    const page = await dashboard(b);
    expect(page).toMatch(/id="count"[^>]*>1</);
    expect(page).not.toContain("Demo developer");
  });

  it("streams their own live Plays", async () => {
    const b = browser();
    await signIn(b, "code-ada");
    const key = keyOn(await dashboard(b))!;
    const controller = new AbortController();
    const res = await b("/api/plays/stream", { signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    await postPlays(demo.key);
    await postPlays(key);
    let text = "";
    while (!text.includes("<td>zod</td>")) text += (await reader.read()).value;
    expect(text).toMatch(/id: \w+\.1\n/);
    expect(text).not.toMatch(/id: \w+\.2\n/);
    controller.abort();
  });

  it("gives one copy-paste install command with the service URL and their key", async () => {
    const b = browser();
    await signIn(b, "code-ada");
    const page = await dashboard(b);
    const key = keyOn(page)!;
    expect(page).toContain(
      `curl -fsSL ${PUBLIC_URL}/install.ts | node --input-type=module-typescript - ${PUBLIC_URL} ${key}`,
    );
  });
});

describe("PlayCount key rotation", () => {
  it("replaces the key, and the old key stops working at once", async () => {
    const b = browser();
    await signIn(b, "code-ada");
    const oldKey = keyOn(await dashboard(b))!;
    expect((await postPlays(oldKey)).status).toBe(202);

    const res = await b("/key/rotate", { method: "POST" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");

    const newKey = keyOn(await dashboard(b))!;
    expect(newKey).not.toBe(oldKey);
    expect((await postPlays(oldKey)).status).toBe(401);
    expect((await postPlays(newKey)).status).toBe(202);
    // Plays already recorded stay with the Developer.
    expect(await dashboard(b)).toMatch(/id="count"[^>]*>2</);
  });

  it("is refused without a signed-in Developer", async () => {
    const res = await browser()("/key/rotate", { method: "POST" });
    expect(res.status).toBe(401);
    expect((await postPlays(demo.key)).status).toBe(202);
  });
});

describe("Capture install files", () => {
  it("serves the installer and the capture files it downloads", async () => {
    for (const path of ["/install.ts", "/capture/src/play.ts", "/capture/src/capture/hook.ts", "/capture/src/capture/docs-server.ts"]) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toMatch(/import|export/);
    }
  });

  it("serves nothing outside the capture files", async () => {
    for (const path of ["/capture/src/server/main.ts", "/capture/package.json", "/capture/..%2F..%2Fpackage.json"]) {
      expect((await fetch(`${server.url}${path}`)).status, path).toBe(404);
    }
  });
});
