# PlayCount

Your coding agent splits a monthly budget between the open-source projects it actually used. Terms are defined in [GLOSSARY.md](GLOSSARY.md); the v1 spec is issue #1.

## Run it locally

Needs Node 22.18 or later (it runs the TypeScript directly).

```sh
npm install
PLAYCOUNT_DEMO_KEY=pk_local npm start      # dashboard at http://localhost:3000
```

Point Claude Code at it by adding the capture hook to `~/.claude/settings.json`:

```json
{
  "env": { "PLAYCOUNT_URL": "http://localhost:3000", "PLAYCOUNT_KEY": "pk_local" },
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "node /path/to/playcount/src/capture/hook.ts" }] }
    ]
  }
}
```

When the agent writes or edits code that imports an npm package (`import`, `require` or `import()`), a Play appears on the dashboard. If PlayCount is unreachable, Plays wait in `~/.playcount/queue.jsonl` (or `$PLAYCOUNT_QUEUE_DIR`) and are sent on a later run. Only the Play log leaves your machine, never source code ([ADR 0001](docs/adr/0001-play-log-only-no-source-code.md)).

## Develop

```sh
npm test           # vitest
npm run typecheck  # tsc
```
