#!/usr/bin/env node
// Claude Code PostToolUse hook. Reads the tool event on stdin, turns it into Plays
// on this machine, and sends only those Plays to PlayCount (ADR 0001).
// It must never fail or slow the Agent's tool call, so every error is swallowed.
import { playsFromToolEvent, type ToolEvent } from "./plays.ts";

const url = process.env.PLAYCOUNT_URL ?? "http://localhost:3000";
const key = process.env.PLAYCOUNT_KEY;

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

try {
  if (key) {
    const event = JSON.parse(await readStdin()) as ToolEvent;
    const plays = playsFromToolEvent(event, new Date().toISOString());
    if (plays.length) {
      await fetch(`${url.replace(/\/$/, "")}/api/plays`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ plays }),
        signal: AbortSignal.timeout(2000),
      });
    }
  }
} catch {
  // Swallowed on purpose: capture is best effort until local queueing lands (#4).
}
process.exit(0);
