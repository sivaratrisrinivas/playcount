// Simulated Developers: seeded demo data that shows maintainer totals across many Agents.
// They are labelled everywhere: each one's name ends "(simulated)", the Developer and their
// Budget are marked simulated, and so is every Settlement and payout note their Budget pays for.
// Each has their own Budget and Play log, so their money pays only for their own Plays.
import { randomBytes } from "node:crypto";
import type { Play } from "../play.ts";
import type { Developer } from "./developers.ts";
import type { Ledger } from "./ledger.ts";
import { periodOf } from "./statement.ts";

export const MAX_SIMULATED = 20;

const NAMES = ["Asha", "Mateo", "Lin", "Kofi", "Sara", "Yuki", "Omar", "Ines", "Priya", "Tomas"];
const BUDGETS = [10, 25, 5, 15, 20, 12, 8, 30];
// What different Agents build with, most played first, and the file type they mostly write.
const STACKS: { projects: string[]; ext: string }[] = [
  { projects: ["hono", "zod", "drizzle-orm", "@hono/zod-validator", "vitest"], ext: "ts" },
  { projects: ["react", "next", "@tanstack/react-query", "zod", "clsx"], ext: "tsx" },
  { projects: ["express", "zod", "pg", "dotenv", "jsonwebtoken"], ext: "js" },
  { projects: ["react", "react-router", "date-fns", "axios", "hono"], ext: "tsx" },
  { projects: ["hono", "@prisma/client", "zod", "lodash"], ext: "ts" },
  { projects: ["ag-grid-community", "react", "date-fns", "zod"], ext: "tsx" },
  { projects: ["vue", "pinia", "axios", "dayjs"], ext: "ts" },
  { projects: ["fastify", "zod", "pino", "undici"], ext: "ts" },
];

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// A small seeded generator (mulberry32), so the same seed always gives the same Plays.
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

// One Agent's Plays from the start of the period up to `now`: a session or two on most days,
// each a run of imports written and docs read, leaning on the first Projects of its stack.
function playsFor(index: number, periodStart: Date, now: Date): Play[] {
  const rand = random(index + 1);
  const { projects, ext } = STACKS[index % STACKS.length];
  // Earlier Projects in the stack are played more: weights 1, 1/2, 1/3, ...
  const weights = projects.map((_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const pick = () => {
    let r = rand() * total;
    return projects[weights.findIndex((w) => (r -= w) < 0)] ?? projects[0];
  };

  const plays: Play[] = [];
  for (let day = periodStart.getTime(), d = 0; day <= now.getTime(); day += DAY, d++) {
    if (rand() < 0.25) continue; // a day off
    const sessions = rand() < 0.4 ? 2 : 1;
    for (let s = 0; s < sessions; s++) {
      let at = day + (8 + Math.floor(rand() * 12)) * HOUR + Math.floor(rand() * 60) * 60_000;
      const count = 3 + Math.floor(rand() * 13);
      for (let n = 0; n < count && at <= now.getTime(); n++, at += Math.floor(1 + rand() * 6) * 60_000) {
        const session_id = `sim-${index + 1}-${d + 1}-${s + 1}`;
        const project = pick();
        plays.push(
          rand() < 0.25
            ? { kind: "docs", project, session_id, at: new Date(at).toISOString() }
            : { kind: "import", project, lines_written: 1 + Math.floor(rand() ** 2 * 40), file_ext: ext, session_id, at: new Date(at).toISOString() },
        );
      }
    }
  }
  return plays.sort((a, b) => a.at.localeCompare(b.at));
}

// Seeds `count` simulated Developers into the Ledger, each with a Budget from the start of the
// current period and the Plays their Agent made so far this period. Returns the Developers, to be
// added to the Developers list.
export function simulatedDevelopers({ ledger, count, now }: { ledger: Ledger; count: number; now: Date }): Developer[] {
  const periodStart = new Date(`${periodOf(now)}-01T00:00:00.000Z`);
  return Array.from({ length: Math.min(count, MAX_SIMULATED) }, (_, i) => {
    const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : "");
    const developer: Developer = {
      id: `dev_sim_${i + 1}`,
      name: `${name} (simulated)`,
      // Never shown anywhere, so no one can send Plays as a simulated Developer.
      key: `pk_sim_${randomBytes(24).toString("base64url")}`,
      simulated: true,
    };
    ledger.recordBudget(developer.id, { amountCents: BUDGETS[i % BUDGETS.length] * 100, since: periodStart.toISOString(), simulated: true });
    ledger.recordPlays(developer.id, playsFor(i, periodStart, now));
    return developer;
  });
}
