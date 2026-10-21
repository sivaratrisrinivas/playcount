import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PLAYS_PER_BATCH as MAX_BATCH, parsePlay, type Play } from "../play.ts";
import type { Developer, Developers } from "./developers.ts";
import type { GitHub } from "./github.ts";
import type { Ledger } from "./ledger.ts";
import { dashboardPage, landingPage, playRow } from "./dashboard.ts";
import { isPeriod, periodOf, statementOf } from "./statement.ts";

export type AppDeps = {
  ledger: Ledger;
  developers: Developers;
  // The seeded Developer the dashboard shows to visitors who have not signed in.
  demoDeveloperId?: string;
  // GitHub sign-in; without it, only the seeded Developer exists.
  github?: GitHub;
  // The address Developers reach this service at, e.g. https://playcount.onrender.com.
  // Behind a proxy the request's own URL can say http, so this is configured.
  publicUrl?: string;
  // Decides the current period; tests pass a fixed one.
  clock?: () => Date;
};

// Keeps idle live streams open through proxies that drop silent connections.
const KEEPALIVE_MS = 15_000;

// How long a browser waits before reconnecting a dropped live stream.
const RETRY_MS = 1000;
const noop = () => {};

function parseCursor(value: string) {
  const match = value.match(/^([a-z0-9]{1,20})\.(\d{1,9})$/);
  return match ? { run: match[1], count: Number(match[2]) } : undefined;
}

// AG Grid is served from the installed package so the dashboard works without a CDN.
// The browser bundle isn't in the package's exports, so it is found next to the main entry.
const AG_GRID = join(dirname(createRequire(import.meta.url).resolve("ag-grid-community")), "..", "ag-grid-community.min.js");

// The files the install command downloads to the Developer's machine, served from this checkout.
// Only these are served: the hook, the docs tool and what they import, plus the installer.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAPTURE_FILES = ["src/play.ts", "src/capture/hook.ts", "src/capture/plays.ts", "src/capture/queue.ts", "src/capture/docs-server.ts"];
const INSTALLER = "src/capture/install.ts";

const SESSION = "pc_session";
const OAUTH_STATE = "pc_oauth_state";
const token = () => randomBytes(24).toString("base64url");

// The one command a Developer pastes into a terminal to install capture (see install.ts).
export const installCommand = (url: string, key: string) =>
  `curl -fsSL ${url}/install.ts | node --input-type=module-typescript - ${url} ${key}`;

export function createApp({ ledger, developers, demoDeveloperId, github, publicUrl, clock = () => new Date() }: AppDeps) {
  const app = new Hono();
  // Names this service run in stream cursors, so a browser's cursor from an earlier run is spotted.
  const run = (Date.now() + Math.random()).toString(36).replace(".", "");
  const cursor = (count: number) => `${run}.${count}`;

  const developerOf = (c: Context) => {
    const key = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    return key ? developers.byKey(key) : undefined;
  };

  // Signed-in browsers, by session cookie. Kept in memory, like the Ledger for now.
  const sessions = new Map<string, string>();
  const signedIn = (c: Context): Developer | undefined => {
    const id = sessions.get(getCookie(c, SESSION) ?? "");
    return id ? developers.byId(id) : undefined;
  };
  // Whose dashboard this browser sees: its signed-in Developer, else the seeded demo Developer.
  const viewerOf = (c: Context) => signedIn(c) ?? (demoDeveloperId ? developers.byId(demoDeveloperId) : undefined);

  const baseUrl = (c: Context) => (publicUrl ?? new URL(c.req.url).origin).replace(/\/$/, "");
  const cookieOptions = (c: Context) =>
    ({ path: "/", httpOnly: true, sameSite: "Lax", secure: baseUrl(c).startsWith("https:") }) as const;
  const callbackUrl = (c: Context) => `${baseUrl(c)}/auth/github/callback`;

  app.get("/auth/github", (c) => {
    if (!github) return c.text("GitHub sign-in is not configured on this PlayCount service.", 503);
    const state = token();
    setCookie(c, OAUTH_STATE, state, { ...cookieOptions(c), maxAge: 600 });
    return c.redirect(github.authorizeUrl(state, callbackUrl(c)), 302);
  });

  app.get("/auth/github/callback", async (c) => {
    if (!github) return c.text("GitHub sign-in is not configured on this PlayCount service.", 503);
    const expected = getCookie(c, OAUTH_STATE);
    deleteCookie(c, OAUTH_STATE, cookieOptions(c));
    const { code, state } = c.req.query();
    if (!expected || state !== expected) return c.text("This sign-in link has expired. Sign in again.", 400);
    if (!code) return c.text("GitHub did not complete the sign-in.", 400);

    const user = await github.userFromCode(code, callbackUrl(c)).catch(() => undefined);
    if (!user) return c.text("GitHub did not accept this sign-in. Sign in again.", 401);
    const session = token();
    sessions.set(session, developers.signIn(user).id);
    setCookie(c, SESSION, session, { ...cookieOptions(c), maxAge: 30 * 24 * 3600 });
    return c.redirect("/", 302);
  });

  app.post("/auth/signout", (c) => {
    sessions.delete(getCookie(c, SESSION) ?? "");
    deleteCookie(c, SESSION, cookieOptions(c));
    return c.redirect("/", 303);
  });

  // The session cookie is SameSite=Lax, so another site cannot post this form as the Developer.
  app.post("/key/rotate", (c) => {
    const developer = signedIn(c);
    if (!developer) return c.text("Sign in to rotate your PlayCount key.", 401);
    developers.rotateKey(developer.id);
    return c.redirect("/", 303);
  });

  app.post("/api/plays", async (c) => {
    const developer = developerOf(c);
    if (!developer) return c.json({ error: "unknown PlayCount key" }, 401);

    const body = await c.req.json().catch(() => null);
    const batch: unknown = body?.plays;
    if (!Array.isArray(batch) || batch.length > MAX_BATCH) {
      return c.json({ error: `expected { plays: [...] } with at most ${MAX_BATCH} Plays` }, 400);
    }
    const plays: Play[] = [];
    for (const [i, item] of batch.entries()) {
      const p = parsePlay(item);
      if (!p) return c.json({ error: `Play ${i} is not a valid Play-log entry` }, 400);
      plays.push(p);
    }

    ledger.recordPlays(developer.id, plays);
    return c.json({ recorded: plays.length }, 202);
  });

  // The dashboard Developer's live Play stream, as Server-Sent Events. Each Play event is one
  // Play, rendered as a dashboard row, and its id is a cursor: this service run, then the Play's
  // number in the Play log, which is the Developer's count once that Play is shown. A reconnecting
  // browser sends the last cursor it saw and gets every Play it missed. "statement" events carry
  // the current period's statement as it changes.
  app.get("/api/plays/stream", (c) => {
    const viewer = viewerOf(c);
    if (!viewer) return c.notFound();
    const developerId = viewer.id;
    return streamSSE(c, async (stream) => {
      const recorded = ledger.playsOf(developerId);
      const from = parseCursor(c.req.header("last-event-id") ?? c.req.query("since") ?? cursor(recorded.length));

      // Writes go out in order: a missed-Play replay, then live Plays as the Ledger records them.
      let writes = Promise.resolve();
      const write = (next: () => Promise<unknown>) => {
        writes = writes.then(() => (stream.aborted ? undefined : next())).then(noop, noop);
      };
      // After new Plays, one statement follows them, computed when it is written, so a batch
      // of Plays costs one statement rather than one each.
      let statementQueued = false;
      const sendPlay = (play: Play, number: number) => {
        write(() => stream.writeSSE({ id: cursor(number), data: String(playRow(play)) }));
        if (statementQueued) return;
        statementQueued = true;
        write(() => {
          statementQueued = false;
          const statement = statementOf(ledger.playsOf(developerId), periodOf(clock()));
          return stream.writeSSE({ event: "statement", data: JSON.stringify(statement) });
        });
      };

      const stop = ledger.onPlays(developerId, sendPlay);
      stream.onAbort(stop);

      if (from?.run !== run || from.count > recorded.length) {
        // The browser's cursor is from another service run, whose in-memory Ledger is gone.
        write(() => stream.writeSSE({ event: "reset", data: "", retry: RETRY_MS }));
      } else {
        write(() => stream.writeSSE({ event: "hello", data: "", retry: RETRY_MS }));
        recorded.slice(from.count).forEach((play, i) => sendPlay(play, from.count + i + 1));
      }

      while (!stream.aborted) {
        await stream.sleep(KEEPALIVE_MS);
        write(() => stream.write(": keepalive\n\n"));
      }
      stop();
      await writes;
    });
  });

  app.get("/api/statement", (c) => {
    const developer = developerOf(c);
    if (!developer) return c.json({ error: "unknown PlayCount key" }, 401);
    const period = c.req.query("period") ?? periodOf(clock());
    if (!isPeriod(period)) return c.json({ error: "period must be a month written YYYY-MM" }, 400);
    return c.json(statementOf(ledger.playsOf(developer.id), period));
  });

  // Render polls this before switching traffic to a new deploy.
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/", (c) => {
    const developer = signedIn(c);
    const viewer = viewerOf(c);
    const signIn = github ? "available" : "off";
    if (!viewer) return c.html(landingPage(signIn));
    const plays = ledger.playsOf(viewer.id).reverse();
    const statement = statementOf(plays, periodOf(clock()));
    const setup = developer && { key: developer.key, installCommand: installCommand(baseUrl(c), developer.key) };
    return c.html(dashboardPage({ name: viewer.name, plays, statement, cursor: cursor(plays.length), setup, signIn }));
  });

  const serveSource = async (c: Context, file: string) =>
    c.body(await readFile(join(ROOT, file), "utf8"), 200, { "content-type": "text/plain; charset=utf-8" });
  app.get("/install.ts", (c) => serveSource(c, INSTALLER));
  app.get("/capture/files.json", (c) => c.json(CAPTURE_FILES));
  app.get("/capture/*", (c) => {
    const file = c.req.path.slice("/capture/".length);
    return CAPTURE_FILES.includes(file) ? serveSource(c, file) : c.notFound();
  });

  let agGrid: Promise<string> | undefined;
  app.get("/vendor/ag-grid-community.min.js", async (c) => {
    agGrid ??= readFile(AG_GRID, "utf8").catch((err) => {
      agGrid = undefined;
      throw err;
    });
    c.header("cache-control", "public, max-age=86400");
    return c.body(await agGrid, 200, { "content-type": "text/javascript; charset=utf-8" });
  });

  return app;
}
