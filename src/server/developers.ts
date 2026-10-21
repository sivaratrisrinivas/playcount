export type Developer = { id: string; name: string; key: string };

export interface Developers {
  byKey(key: string): Developer | undefined;
  byId(id: string): Developer | undefined;
}

export function inMemoryDevelopers(list: Developer[]): Developers {
  return {
    byKey: (key) => list.find((d) => d.key === key),
    byId: (id) => list.find((d) => d.id === id),
  };
}
