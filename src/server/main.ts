// Starts the PlayCount service. Developers sign up with GitHub when GITHUB_CLIENT_ID and
// GITHUB_CLIENT_SECRET are set. A demo Developer can also be seeded from PLAYCOUNT_DEMO_KEY;
// visitors who have not signed in see their dashboard, with a seeded Budget (PLAYCOUNT_DEMO_BUDGET
// dollars, default 10). Developers fund their own Budgets through PayPal Subscriptions when
// PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set (PAYPAL_API_URL defaults to the sandbox).
import { inMemoryDevelopers, type Developer } from "./developers.ts";
import { githubOAuth } from "./github.ts";
import { inMemoryLedger } from "./ledger.ts";
import { paypalRest } from "./paypal.ts";
import { startServer } from "./server.ts";

const env = process.env;
const demo: Developer | undefined = env.PLAYCOUNT_DEMO_KEY
  ? { id: "dev_demo", name: env.PLAYCOUNT_DEMO_NAME ?? "Demo developer", key: env.PLAYCOUNT_DEMO_KEY }
  : undefined;
const github =
  env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
    ? githubOAuth({ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET })
    : undefined;
const paypal =
  env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
    ? paypalRest({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, apiUrl: env.PAYPAL_API_URL || undefined })
    : undefined;
if (!demo && !github) {
  console.error("Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET for sign-up, or PLAYCOUNT_DEMO_KEY to seed a demo Developer.");
  process.exit(1);
}

const ledger = inMemoryLedger();
if (demo) {
  const cents = Math.round(Number(env.PLAYCOUNT_DEMO_BUDGET || 10) * 100);
  if (!(cents >= 100)) {
    console.error("PLAYCOUNT_DEMO_BUDGET must be a dollar amount of at least 1.");
    process.exit(1);
  }
  ledger.recordBudget(demo.id, { amountCents: cents, since: new Date().toISOString() });
}

const server = await startServer({
  ledger,
  developers: inMemoryDevelopers(demo ? [demo] : []),
  demoDeveloperId: demo?.id,
  github,
  paypal,
  // Render sets RENDER_EXTERNAL_URL to the service's public https address.
  publicUrl: env.PLAYCOUNT_PUBLIC_URL || env.RENDER_EXTERNAL_URL,
  port: Number(env.PORT ?? 3000),
});
console.log(`PlayCount listening on ${server.url}`);
if (!github) console.log("GitHub sign-in is off: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set.");
if (!paypal) console.log("Budgets are off: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set.");
