// The hook's local queue of Plays PlayCount has not accepted yet, one JSON Play per
// line. Several hooks can run at once, so a run takes the queue by renaming it
// (atomic), and deletes what it took only once the Plays are sent or queued again.
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { parsePlay, type Play } from "../play.ts";

const QUEUE = "queue.jsonl";
const MAX_QUEUED = 10_000; // newest kept, so a long outage cannot fill the disk
const ABANDONED_MS = 60_000; // a taken batch this old belongs to a hook that was killed

export async function enqueue(dir: string, plays: Play[]): Promise<void> {
  if (!plays.length) return;
  await mkdir(dir, { recursive: true });
  const kept = plays.slice(-MAX_QUEUED);
  await appendFile(join(dir, QUEUE), kept.map((p) => JSON.stringify(p) + "\n").join(""));
}

// Takes every queued Play, including batches abandoned by killed hooks. Call
// `release` after the Plays are sent or queued again; until then a killed run
// leaves them on disk for a later run to take.
export async function takeQueued(dir: string): Promise<{ plays: Play[]; release: () => Promise<void> }> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const now = new Date();
  const plays: Play[] = [];
  const taken: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (name !== QUEUE) {
      if (!name.startsWith("taken-")) continue;
      const age = now.getTime() - (await stat(path).catch(() => ({ mtimeMs: now.getTime() }))).mtimeMs;
      if (age < ABANDONED_MS) continue;
    }
    const mine = join(dir, `taken-${process.pid}-${now.getTime()}-${Math.random().toString(36).slice(2)}`);
    try {
      await rename(path, mine);
      await utimes(mine, now, now); // rename keeps the old mtime; mark when it was taken
    } catch {
      continue; // another hook took it first
    }
    taken.push(mine);
    const text = await readFile(mine, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      try {
        const play = line ? parsePlay(JSON.parse(line)) : null;
        if (play) plays.push(play); // a Play PlayCount would reject is dropped, not resent forever
      } catch {
        // a torn line from a killed write; skip it
      }
    }
  }
  return {
    plays: plays.slice(-MAX_QUEUED),
    release: async () => {
      await Promise.all(taken.map((path) => rm(path, { force: true })));
    },
  };
}
