// Claims: a maintainer proves control of a Project by signing in with GitHub and having push
// access to the repo named in the package's npm `repository` field, and gives the one PayPal
// email its Royalties are paid to. The Unclaimed royalties held for it are paid from then on.
import { isProjectName } from "../play.ts";
import type { GitHub } from "./github.ts";
import type { Ledger } from "./ledger.ts";
import { githubRepoOf, type Npm } from "./npm.ts";
import { heldByProject } from "./settlement.ts";

export const projectPath = (project: string) => `/projects/${project}`;

export const isPayoutEmail = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// What anyone may see about a Project: never its payout address. What simulated Developers'
// Settlements hold is shown apart, since no money backs it.
export type ProjectView = {
  project: string;
  held_cents: number;
  simulated_held_cents: number;
  claimed: boolean;
  claimed_by?: string;
  claimed_at?: string;
};

type ClaimError = 400 | 403 | 404 | 409 | 422 | 502 | 503;
export type ClaimResult = { ok: true } | { ok: false; status: ClaimError; error: string };
const fail = (status: ClaimError, error: string): ClaimResult => ({ ok: false, status, error });

export function claimService({ ledger, npm, github, clock }: { ledger: Ledger; npm?: Npm; github?: GitHub; clock: () => Date }) {
  return {
    view(project: string): ProjectView {
      const claim = ledger.claimOf(project);
      // A release is shown as paid only once PayPal confirms its batch; until then it is still held.
      const settlements = ledger.allSettlements().map(({ settlement: s }) => (s.status === "settled" ? s : { ...s, releases: [] }));
      const heldBy = (simulated: boolean) => heldByProject(settlements.filter((s) => Boolean(s.simulated) === simulated)).get(project) ?? 0;
      return {
        project,
        held_cents: heldBy(false),
        simulated_held_cents: heldBy(true),
        claimed: Boolean(claim),
        claimed_by: claim?.claimedBy,
        claimed_at: claim?.claimedAt,
      };
    },

    // Claims the Project for the signed-in GitHub user, whose token checks their push access.
    async claim(project: string, by: { login: string; token: string }, payoutEmail: string): Promise<ClaimResult> {
      if (!isProjectName(project)) return fail(404, "there is no such Project");
      if (!npm || !github) return fail(503, "Claims are not available on this PlayCount service");
      if (ledger.claimOf(project)) return fail(409, `the Project ${project} is already claimed`);
      if (!isPayoutEmail(payoutEmail)) return fail(400, "give the PayPal email this Project's Royalties are paid to");

      const pkg = await npm.packageOf(project).catch((err) => {
        console.error(`npm lookup failed for ${project}:`, err);
        return null;
      });
      if (pkg === null) return fail(502, "npm did not answer. Try again in a moment");
      if (!pkg) return fail(404, `there is no npm package named ${project}`);
      const repo = githubRepoOf(pkg.repository);
      if (!repo) return fail(422, `the npm repository field of ${project} names no GitHub repo, so it cannot be claimed with GitHub`);

      const canPush = await github.canPush(by.token, repo.owner, repo.repo).catch((err) => {
        console.error(`GitHub push check failed for ${project}:`, err);
        return null;
      });
      if (canPush === null) return fail(502, "GitHub did not answer. Try again in a moment");
      if (!canPush) {
        return fail(403, `GitHub user ${by.login} cannot push to github.com/${repo.owner}/${repo.repo}, the repo npm names for ${project}, so they cannot claim it`);
      }
      if (!ledger.recordClaim(project, { payoutEmail, claimedBy: by.login, claimedAt: clock().toISOString() })) {
        return fail(409, `the Project ${project} is already claimed`);
      }
      return { ok: true };
    },
  };
}
