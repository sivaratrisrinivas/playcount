import { randomBytes } from "node:crypto";
import type { GitHubUser } from "./github.ts";

export type Developer = { id: string; name: string; key: string; githubId?: number };

export interface Developers {
  byKey(key: string): Developer | undefined;
  byId(id: string): Developer | undefined;
  // Finds the Developer who signed in with this GitHub user, or creates one with a new PlayCount key.
  signIn(user: GitHubUser): Developer;
  // Gives the Developer a new PlayCount key; the old one stops working at once.
  rotateKey(id: string): Developer | undefined;
}

const newKey = () => `pk_${randomBytes(24).toString("base64url")}`;

export function inMemoryDevelopers(seeded: Developer[]): Developers {
  const list = seeded.map((d) => ({ ...d }));
  return {
    byKey: (key) => list.find((d) => d.key === key),
    byId: (id) => list.find((d) => d.id === id),
    signIn(user) {
      const found = list.find((d) => d.githubId === user.id);
      if (found) return found;
      const developer = { id: `dev_gh_${user.id}`, name: user.name ?? user.login, key: newKey(), githubId: user.id };
      list.push(developer);
      return developer;
    },
    rotateKey(id) {
      const developer = list.find((d) => d.id === id);
      if (developer) developer.key = newKey();
      return developer;
    },
  };
}
