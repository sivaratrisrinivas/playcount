// The GitHub adapter: OAuth sign-in for Developers (and, with #13, push-access checks
// for Claims). The real one talks to github.com; tests use the fake.

export type GitHubUser = { id: number; login: string; name: string | null };

export interface GitHub {
  // Where to send the browser to sign in; GitHub returns it to redirectUri with a code and this state.
  authorizeUrl(state: string, redirectUri: string): string;
  // The GitHub user a callback's code belongs to, or undefined if GitHub does not accept the code.
  userFromCode(code: string, redirectUri: string): Promise<GitHubUser | undefined>;
}

const TIMEOUT_MS = 10_000;

export function githubOAuth({ clientId, clientSecret }: { clientId: string; clientSecret: string }): GitHub {
  return {
    authorizeUrl(state, redirectUri) {
      // No scope: sign-in only needs the user's public identity.
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, allow_signup: "true" });
      return `https://github.com/login/oauth/authorize?${params}`;
    },
    async userFromCode(code, redirectUri) {
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
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "PlayCount" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!userRes.ok) return undefined;
      const user = (await userRes.json()) as { id?: unknown; login?: unknown; name?: unknown };
      if (typeof user.id !== "number" || typeof user.login !== "string") return undefined;
      return { id: user.id, login: user.login, name: typeof user.name === "string" && user.name ? user.name : null };
    },
  };
}

// A GitHub that accepts the given codes, each standing for one user's sign-in.
export function fakeGitHub(users: Record<string, GitHubUser>): GitHub {
  return {
    authorizeUrl: (state, redirectUri) =>
      `https://github.test/login/oauth/authorize?${new URLSearchParams({ state, redirect_uri: redirectUri })}`,
    userFromCode: async (code) => users[code],
  };
}
