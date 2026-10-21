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

When the agent writes a new file that imports an npm package, or reads a package's docs with `read_docs`, a Play appears on the dashboard. (Edits to existing files are counted from ticket #4. Docs read through Context7 or WebFetch are not counted.) Only the Play log leaves your machine, never source code ([ADR 0001](docs/adr/0001-play-log-only-no-source-code.md)).

## Develop

```sh
npm test           # vitest
npm run typecheck  # tsc
```
