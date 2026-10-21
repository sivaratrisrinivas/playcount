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

When the agent writes a new file that imports an npm package, a Play appears on the dashboard. (Edits to existing files are counted from ticket #4.) The dashboard also shows this month's statement: each Project your Agent played, with its import Plays, docs Plays and lines written. The same totals come from `GET /api/statement?period=YYYY-MM` with your PlayCount key in an `Authorization: Bearer …` header (the period defaults to the current month, UTC).

Only the Play log leaves your machine, never source code ([ADR 0001](docs/adr/0001-play-log-only-no-source-code.md)).

## Deploy to Render

[`render.yaml`](render.yaml) is a Render Blueprint. In Render, choose **New → Blueprint** and pick this repo. It deploys `main` each time CI passes and checks `/health` before switching traffic.

Config comes only from the environment, never the repo. Render generates `PLAYCOUNT_DEMO_KEY`; the PayPal, Anthropic and GitHub secrets are entered in the service's **Environment** tab (they can stay blank until a ticket needs them).

To capture Plays on the hosted service, set the hook's `PLAYCOUNT_URL` to the service's `onrender.com` URL and `PLAYCOUNT_KEY` to the generated `PLAYCOUNT_DEMO_KEY`.

## Develop

```sh
npm test           # vitest
npm run typecheck  # tsc
```
