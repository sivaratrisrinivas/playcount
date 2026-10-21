// Starts the PlayCount service. Developers sign up with GitHub when GITHUB_CLIENT_ID and
// GITHUB_CLIENT_SECRET are set. A demo Developer can also be seeded from PLAYCOUNT_DEMO_KEY;
// visitors who have not signed in see their dashboard.
import { inMemoryDevelopers, type Developer } from "./developers.ts";
import { githubOAuth } from "./github.ts";
import { inMemoryLedger } from "./ledger.ts";
import { startServer } from "./server.ts";

const env = process.env;
const demo: Developer | undefined = env.PLAYCOUNT_DEMO_KEY
  ? { id: "dev_demo", name: env.PLAYCOUNT_DEMO_NAME ?? "Demo developer", key: env.PLAYCOUNT_DEMO_KEY }
  : undefined;
const github =
  env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
    ? githubOAuth({ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET })
    : undefined;
if (!demo && !github) {
  console.error("Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET for sign-up, or PLAYCOUNT_DEMO_KEY to seed a demo Developer.");
  process.exit(1);
}

const server = await startServer({
  ledger: inMemoryLedger(),
  developers: inMemoryDevelopers(demo ? [demo] : []),
  demoDeveloperId: demo?.id,
  github,
  // Render sets RENDER_EXTERNAL_URL to the service's public https address.
  publicUrl: env.PLAYCOUNT_PUBLIC_URL || env.RENDER_EXTERNAL_URL,
  port: Number(env.PORT ?? 3000),
});
console.log(`PlayCount listening on ${server.url}`);
if (!github) console.log("GitHub sign-in is off: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set.");
