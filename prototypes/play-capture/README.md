# PROTOTYPE: play capture (throwaway)

Question: can we reliably capture **plays** (written npm imports + docs reads) from a Claude Code session, without sending source code anywhere?

- `hook.mjs`: Claude Code `PostToolUse` hook. On Edit/Write/MultiEdit it extracts npm imports from the new text and counts lines using each import's bindings. On docs tools (`mcp__playcount__read_docs`, `mcp__context7__*`) it records a docs play. Appends play-log lines (no source code) to `$PLAYCOUNT_LOG` (default `.playcount/plays.jsonl`).
- `docs-server.mjs`: zero-dependency stdio MCP server exposing `read_docs(package)`, which returns the npm README and logs a docs play.
- `demo-project/`: a scratch project wired to both; run `claude -p "..."` inside it, then `cat .playcount/plays.jsonl`.

## Verdict (2026-10-20): capture works, with two fixes needed for the real build

A real headless Claude Code session (`claude -p "Add email+password validation to src/Signup.tsx using zod and react-hook-form. Read the zod docs with the read_docs tool first."`) produced this play log, with no source code in it:

```jsonl
{"kind":"docs","project":"zod","via":"playcount"}
{"kind":"import","project":"react-hook-form","lines_written":1,"file_ext":"tsx"}
{"kind":"import","project":"@hookform/resolvers","lines_written":1,"file_ext":"tsx"}
{"kind":"import","project":"zod","lines_written":4,"file_ext":"tsx"}
```

What it settled:
- `PostToolUse` hooks on `Write|Edit|MultiEdit` fire reliably and carry the new text, so imports and lines written against them can be computed on the developer's machine (ADR 0001 holds).
- A docs MCP tool is called when the agent is told docs exist; the hook sees the call and logs a docs play.
- Scoped packages (`@hookform/resolvers/zod` → `@hookform/resolvers`), `node:` built-ins and relative imports are handled.

Fixes for the real build:
1. **Edits that use an existing import are missed.** An `Edit` only carries the changed snippet, so if the import line is outside it, nothing is logged. Fix: on `Edit`/`MultiEdit`, read the full file from disk (locally) to resolve imports, then count only the new lines.
2. **Context7 names libraries by GitHub path** (`/colinhacks/zod`), not npm name. Fix: map via the npm registry's `repository` field, or count only our own `read_docs` tool.
3. Project-level `.claude/settings.json` permissions are ignored until the workspace is trusted. Hooks still ran here via `--settings`. The quickstart should install the hook in the user's `~/.claude/settings.json`, or tell users to open the project interactively once.
