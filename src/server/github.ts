// The GitHub adapter: OAuth sign-in for Developers and maintainers, and push-access checks for
// Claims. The real one talks to github.com; tests use the fake.

export type GitHubUser = { id: number; login: string; name: string | null };

// A completed sign-in: who signed in, and the access token that acts as them on GitHub's API.
export type GitHubSignIn = { user: GitHubUser; token: string };

export interface GitHub {
  // Where to send the browser to sign in; GitHub returns it to redirectUri with a code and this state.
  authorizeUrl(state: string, redirectUri: string): string;
  // The sign-in a callback's code belongs to, or undefined if GitHub does not accept the code.
  signInFromCode(code: string, redirectUri: string): Promise<GitHubSignIn | undefined>;
  // Whether the token's user can push to github.com/owner/repo. Throws if GitHub does not answer.
  canPush(token: string, owner: string, repo: string): Promise<boolean>;
}

const TIMEOUT_MS = 10_000;
const API_HEADERS = { accept: "application/vnd.github+json", "user-agent": "PlayCount" };

export function githubOAuth({ clientId, clientSecret }: { clientId: string; clientSecret: string }): GitHub {
  return {
    authorizeUrl(state, redirectUri) {
      // No scope: sign-in needs the user's public identity, and a repo's `permissions` show the
      // user's own access to public repos without one.
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, allow_signup: "true" });
      return `https://github.com/login/oauth/authorize?${params}`;
    },
    async signInFromCode(code, redirectUri) {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // GitHub answers a bad code with 200 and an `error` field rather than a 4xx.
      const token = ((await tokenRes.json().catch(() => null)) as { access_token?: unknown } | null)?.access_token;
      if (!tokenRes.ok || typeof token !== "string") return undefined;

      const userRes = await fetch("https://api.github.com/user", {
        headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!userRes.ok) return undefined;
      const user = (await userRes.json()) as { id?: unknown; login?: unknown; name?: unknown };
      if (typeof user.id !== "number" || typeof user.login !== "string") return undefined;
      return { user: { id: user.id, login: user.login, name: typeof user.name === "string" && user.name ? user.name : null }, token };
    },
    async canPush(token, owner, repo) {
      const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // A repo the user cannot see is one they cannot push to.
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${owner}/${repo}`);
      const body = (await res.json()) as { permissions?: { push?: unknown } };
      return body.permissions?.push === true;
    },
  };
}

// A GitHub that accepts the given codes, each standing for one user's sign-in, and lets each
// login push to the repos listed for it in `push` ("owner/repo", in any letter case).
export function fakeGitHub(users: Record<string, GitHubUser>, push: Record<string, string[]> = {}): GitHub {
  const tokens = new Map<string, GitHubUser>();
  return {
    authorizeUrl: (state, redirectUri) =>
      `https://github.test/login/oauth/authorize?${new URLSearchParams({ state, redirect_uri: redirectUri })}`,
    async signInFromCode(code) {
      const user = users[code];
      if (!user) return undefined;
      const token = `gho_fake_${code}`;
      tokens.set(token, user);
      return { user, token };
    },
    async canPush(token, owner, repo) {
      const user = tokens.get(token);
      const repos = (user && push[user.login]) ?? [];
      return repos.some((r) => r.toLowerCase() === `${owner}/${repo}`.toLowerCase());
    },
  };
}
