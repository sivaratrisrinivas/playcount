// Starts the PlayCount service. Developers sign up with GitHub when GITHUB_CLIENT_ID and
// GITHUB_CLIENT_SECRET are set. A demo Developer can also be seeded from PLAYCOUNT_DEMO_KEY;
// visitors who have not signed in see their dashboard. With GROQ_API_KEY or ASSEMBLYAI_API_KEY set,
// an AI model proposes Weightings (see weigher.ts); without either, they come from Play counts.
import { inMemoryDevelopers, type Developer } from "./developers.ts";
import { githubOAuth } from "./github.ts";
import { inMemoryLedger } from "./ledger.ts";
import { startServer } from "./server.ts";
import { weigherFromEnv } from "./weigher.ts";

const env = process.env;
const demo: Developer | undefined = env.PLAYCOUNT_DEMO_KEY
  ? { id: "dev_demo", name: env.PLAYCOUNT_DEMO_NAME ?? "Demo developer", key: env.PLAYCOUNT_DEMO_KEY }
  : undefined;
const github =
  env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
    ? githubOAuth({ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET })
    : undefined;
const weigher = weigherFromEnv(env);
if (!demo && !github) {
  console.error("Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET for sign-up, or PLAYCOUNT_DEMO_KEY to seed a demo Developer.");
  process.exit(1);
}

const server = await startServer({
  ledger: inMemoryLedger(),
  developers: inMemoryDevelopers(demo ? [demo] : []),
  demoDeveloperId: demo?.id,
  github,
  weigher,
  // Render sets RENDER_EXTERNAL_URL to the service's public https address.
  publicUrl: env.PLAYCOUNT_PUBLIC_URL || env.RENDER_EXTERNAL_URL,
  port: Number(env.PORT ?? 3000),
});
console.log(`PlayCount listening on ${server.url}`);
if (weigher) console.log(`Weightings are proposed by ${weigher.model}.`);
if (!github) console.log("GitHub sign-in is off: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set.");
if (!weigher) console.log("AI Weighting is off: neither GROQ_API_KEY nor ASSEMBLYAI_API_KEY is set, so Weightings come from Play counts.");
