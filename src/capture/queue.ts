// The hook's local queue of Plays PlayCount has not accepted yet, one JSON Play per
// line. Several hooks can run at once, so a run takes the queue by renaming it
// (atomic) and puts back whatever it could not send.
import { appendFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Play } from "../play.ts";

const QUEUE = "queue.jsonl";
const MAX_QUEUED = 10_000; // newest kept, so a long outage cannot fill the disk
const ABANDONED_MS = 60_000; // a taken batch this old belongs to a hook that was killed

export async function enqueue(dir: string, plays: Play[]): Promise<void> {
  if (!plays.length) return;
  await mkdir(dir, { recursive: true });
  const kept = plays.slice(-MAX_QUEUED);
  await appendFile(join(dir, QUEUE), kept.map((p) => JSON.stringify(p) + "\n").join(""));
}

// Removes and returns every queued Play, including batches abandoned by killed hooks.
export async function takeQueued(dir: string): Promise<Play[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  const plays: Play[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (name !== QUEUE) {
      if (!name.startsWith("taken-")) continue;
      const age = now - (await stat(path).catch(() => ({ mtimeMs: now }))).mtimeMs;
      if (age < ABANDONED_MS) continue;
    }
    const taken = join(dir, `taken-${process.pid}-${now}-${Math.random().toString(36).slice(2)}`);
    try {
      await rename(path, taken);
    } catch {
      continue; // another hook took it first
    }
    const text = await readFile(taken, "utf8").catch(() => "");
    await rm(taken, { force: true });
    for (const line of text.split("\n")) {
      try {
        if (line) plays.push(JSON.parse(line) as Play);
      } catch {
        // a torn line from a killed write; skip it
      }
    }
  }
  return plays.slice(-MAX_QUEUED);
}
