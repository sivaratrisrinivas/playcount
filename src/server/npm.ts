// The npm registry adapter: a package's metadata, for the `repository` field a Claim is checked
// against. The real one reads registry.npmjs.org; tests use the fake.

// The latest version's `repository` field exactly as npm has it: a string such as
// "github:owner/repo" or a URL, an object with a `url`, or missing.
export type NpmPackage = { repository?: unknown };

export interface Npm {
  // The package's latest metadata, or undefined if npm has no such package. Throws if npm does not answer.
  packageOf(name: string): Promise<NpmPackage | undefined>;
}

const REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 10_000;

export function npmRegistry(registry = REGISTRY): Npm {
  return {
    async packageOf(name) {
      // A scoped name's slash is part of the name, not the path.
      const res = await fetch(`${registry}/${name.replace("/", "%2F")}/latest`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`npm answered ${res.status} for ${name}`);
      const body = (await res.json()) as { repository?: unknown };
      return { repository: body.repository };
    },
  };
}

export function fakeNpm(packages: Record<string, NpmPackage>): Npm {
  return { packageOf: async (name) => packages[name] };
}

// The GitHub repo a package's `repository` field names, or undefined if it names none. Accepts
// npm's shorthands ("owner/repo", "github:owner/repo") and GitHub URLs in their https, git, ssh
// and scp-like forms.
export function githubRepoOf(repository: unknown): { owner: string; repo: string } | undefined {
  const value = typeof repository === "object" && repository !== null ? (repository as { url?: unknown }).url : repository;
  if (typeof value !== "string") return undefined;
  const spec = value.trim();
  const NAME = "([A-Za-z0-9-]+)/([A-Za-z0-9._-]+?)";
  const match =
    spec.match(new RegExp(`^(?:github:)?${NAME}$`)) ??
    spec.match(new RegExp(`^(?:git\\+)?(?:https?|git|ssh)://(?:[^@/]+@)?(?:www\\.)?github\\.com[:/]${NAME}(?:\\.git)?(?:[/#?].*)?$`, "i")) ??
    spec.match(new RegExp(`^(?:[^@/]+@)?github\\.com:${NAME}(?:\\.git)?(?:#.*)?$`, "i"));
  if (!match) return undefined;
  const [, owner, repo] = match;
  return repo === "." || repo === ".." ? undefined : { owner, repo };
}
