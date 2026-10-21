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
  "permissions": { "allow": ["mcp__playcount__read_docs"] },
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit|MultiEdit|mcp__playcount__read_docs", "hooks": [{ "type": "command", "command": "node /path/to/playcount/src/capture/hook.ts" }] }
    ]
  }
}
```

Then add the PlayCount docs tool, a local MCP server with one tool, `read_docs(package)`, that returns a package's README from the npm registry:

```sh
claude mcp add --scope user playcount -- node /path/to/playcount/src/capture/docs-server.ts
```

When the agent writes or edits code that imports an npm package (`import`, `require` or `import()`), or reads a package's docs with `read_docs`, a Play appears on the dashboard. Docs read through Context7 or WebFetch are not counted. If PlayCount is unreachable, Plays wait in `~/.playcount/queue.jsonl` (or `$PLAYCOUNT_QUEUE_DIR`) and are sent on a later run. The dashboard also shows this month's statement: each Project your Agent played, with its import Plays, docs Plays and lines written. The same totals come from `GET /api/statement?period=YYYY-MM` with your PlayCount key in an `Authorization: Bearer …` header (the period defaults to the current month, UTC).

Only the Play log leaves your machine, never source code ([ADR 0001](docs/adr/0001-play-log-only-no-source-code.md)).

## Deploy to Render

[`render.yaml`](render.yaml) is a Render Blueprint. In Render, choose **New → Blueprint** and pick this repo. It deploys `main` each time CI passes and checks `/health` before switching traffic.

Config comes only from the environment, never the repo. Render generates `PLAYCOUNT_DEMO_KEY`; the PayPal, AssemblyAI and GitHub secrets are entered in the service's **Environment** tab (they can stay blank until a ticket needs them).

To capture Plays on the hosted service, set the hook's `PLAYCOUNT_URL` to the service's `onrender.com` URL and `PLAYCOUNT_KEY` to the generated `PLAYCOUNT_DEMO_KEY`.

It runs on Render's free plan, which sleeps after about 15 idle minutes. Open `/health` and wait for it to answer before a demo, or the first Plays wait in the hook's local queue until it wakes. Plays are kept in memory for now, so a sleep or a deploy clears the dashboard.

## Develop

```sh
npm test           # vitest
npm run typecheck  # tsc
```
