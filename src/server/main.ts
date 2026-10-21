// Starts the PlayCount service. Until signup exists (#8), one Developer is seeded
// from the environment and the dashboard shows their Plays.
import { inMemoryDevelopers } from "./developers.ts";
import { inMemoryLedger } from "./ledger.ts";
import { startServer } from "./server.ts";

const key = process.env.PLAYCOUNT_DEMO_KEY;
if (!key) {
  console.error("Set PLAYCOUNT_DEMO_KEY to the PlayCount key the seeded Developer's hook will use.");
  process.exit(1);
}

const demo = { id: "dev_demo", name: process.env.PLAYCOUNT_DEMO_NAME ?? "Demo developer", key };
const server = await startServer({
  ledger: inMemoryLedger(),
  developers: inMemoryDevelopers([demo]),
  dashboardDeveloperId: demo.id,
  port: Number(process.env.PORT ?? 3000),
});
console.log(`PlayCount listening on ${server.url}`);
