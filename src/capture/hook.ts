#!/usr/bin/env node
// Claude Code PostToolUse hook. Reads the tool event on stdin, turns it into Plays
// on this machine, and sends only those Plays to PlayCount (ADR 0001).
// It must never fail or slow the Agent's tool call, so every error is swallowed,
// and Plays PlayCount does not accept are queued locally for a later run.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_PLAYS_PER_BATCH, parsePlay, type Play } from "../play.ts";
import { needsFileContents, playsFromToolEvent, type ToolEvent } from "./plays.ts";
import { enqueue, takeQueued } from "./queue.ts";

const url = (process.env.PLAYCOUNT_URL ?? "http://localhost:3000").replace(/\/$/, "");
const key = process.env.PLAYCOUNT_KEY;
const queueDir = process.env.PLAYCOUNT_QUEUE_DIR || join(homedir(), ".playcount");
const DEADLINE_MS = 1000;

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

// The Plays in this tool event. For Edit and MultiEdit the file is read here, locally,
// so imports at its top resolve; its contents never leave this function.
async function newPlays(): Promise<Play[]> {
  try {
    const event = JSON.parse(await readStdin()) as ToolEvent;
    const path = event.tool_input?.file_path;
    const fileContents =
      needsFileContents(event) && typeof path === "string" ? await readFile(path, "utf8").catch(() => undefined) : undefined;
    return playsFromToolEvent(event, new Date().toISOString(), fileContents);
  } catch {
    return [];
  }
}

// Sends Plays in batches and returns the ones PlayCount did not accept and may later.
// Every Play here passed parsePlay, so a 400 would only repeat; it is not retried.
async function send(plays: Play[]): Promise<Play[]> {
  const signal = AbortSignal.timeout(DEADLINE_MS);
  for (let i = 0; i < plays.length; i += MAX_PLAYS_PER_BATCH) {
    try {
      const res = await fetch(`${url}/api/plays`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ plays: plays.slice(i, i + MAX_PLAYS_PER_BATCH) }),
        signal,
      });
      if (!res.ok && res.status !== 400) return plays.slice(i);
    } catch {
      return plays.slice(i);
    }
  }
  return [];
}

try {
  if (key) {
    const fresh = await newPlays();
    const queued = await takeQueued(queueDir);
    const plays = [...queued.plays, ...fresh.filter((p) => parsePlay(p))];
    if (plays.length) await enqueue(queueDir, await send(plays));
    await queued.release();
  }
} catch {
  // Swallowed on purpose: capture must never fail the Agent's tool call.
}
process.exit(0);
