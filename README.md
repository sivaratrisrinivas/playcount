# PlayCount

Your coding agent splits a monthly budget between the open-source projects it actually used. Terms are defined in [GLOSSARY.md](GLOSSARY.md); the v1 spec is issue #1.

## Set up capture

Sign in with GitHub on the PlayCount dashboard. It shows your PlayCount key and one command to paste into a terminal (needs Node 22.18 or later):

```sh
curl -fsSL https://playcount.onrender.com/install.ts | node --input-type=module-typescript - https://playcount.onrender.com pk_…
```

The command downloads the capture hook and docs tool into `~/.playcount/capture`, adds the hook, the service URL and your key to your user-level Claude Code settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR`), and registers the docs tool with `claude mcp add --scope user playcount`. User-level settings apply in every repo, so no project has to be trusted first. Start a new Claude Code session afterwards.

Rotate your key on the dashboard if it leaks; the old key stops working at once. Run the install command again with the new key: it replaces the old key and hook rather than adding another.

## Run it locally

Needs Node 22.18 or later (it runs the TypeScript directly).

```sh
npm install
PLAYCOUNT_DEMO_KEY=pk_local npm start      # dashboard at http://localhost:3000
```

`PLAYCOUNT_DEMO_KEY` seeds a demo Developer, whose dashboard visitors see before they sign in. For GitHub sign-in, create a GitHub OAuth app whose callback URL is `http://localhost:3000/auth/github/callback` and set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Then install capture as above with `http://localhost:3000` as the service URL, or with the demo key:

```sh
curl -fsSL http://localhost:3000/install.ts | node --input-type=module-typescript - http://localhost:3000 pk_local
```

The docs tool is a local MCP server with one tool, `read_docs(package)`, that returns a package's README from the npm registry.

When the agent writes or edits code that imports an npm package (`import`, `require` or `import()`), or reads a package's docs with `read_docs`, a Play appears on the dashboard. Docs read through Context7 or WebFetch are not counted. If PlayCount is unreachable, Plays wait in `~/.playcount/queue.jsonl` (or `$PLAYCOUNT_QUEUE_DIR`) and are sent on a later run. The dashboard also shows this month's statement: each Project your Agent played, with its import Plays, docs Plays and lines written. The same totals come from `GET /api/statement?period=YYYY-MM` with your PlayCount key in an `Authorization: Bearer …` header (the period defaults to the current month, UTC).

Only the Play log leaves your machine, never source code ([ADR 0001](docs/adr/0001-play-log-only-no-source-code.md)).

## Deploy to Render

[`render.yaml`](render.yaml) is a Render Blueprint. In Render, choose **New → Blueprint** and pick this repo. It deploys `main` each time CI passes and checks `/health` before switching traffic.

Config comes only from the environment, never the repo. Render generates `PLAYCOUNT_DEMO_KEY`; the PayPal, AssemblyAI and GitHub secrets are entered in the service's **Environment** tab (they can stay blank until a ticket needs them).

GitHub sign-in needs a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps) with the callback URL `https://<service>.onrender.com/auth/github/callback`; its Client ID and a client secret go in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Render sets `RENDER_EXTERNAL_URL`, which PlayCount uses for that callback and the install command (`PLAYCOUNT_PUBLIC_URL` overrides it). Without the GitHub values, sign-in is off and the dashboard shows only the demo Developer.

It runs on Render's free plan, which sleeps after about 15 idle minutes. Open `/health` and wait for it to answer before a demo, or the first Plays wait in the hook's local queue until it wakes. Plays, Developers and sign-ins are kept in memory for now, so a sleep or a deploy clears the dashboard, and Developers who signed up must sign in again and rerun the install command with their new key.

## Develop

```sh
npm test           # vitest
npm run typecheck  # tsc
```
