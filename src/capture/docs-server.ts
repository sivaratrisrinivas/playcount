#!/usr/bin/env node
// The PlayCount docs tool: a stdio MCP server with one tool, read_docs(package), that
// returns the package's README from the npm registry. It records nothing itself; the
// capture hook sees the tool call and records the docs Play (see plays.ts).
import { createInterface } from "node:readline";
import { isProjectName } from "../play.ts";
import { projectOf } from "./plays.ts";

const registry = (process.env.PLAYCOUNT_NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/$/, "");
const MAX_README = 20_000;

const READ_DOCS = {
  name: "read_docs",
  description:
    "Read the official README/documentation for an npm package. Use this whenever you need docs or API details for a library before using it.",
  inputSchema: {
    type: "object",
    properties: { package: { type: "string", description: "npm package name, e.g. zod or @tanstack/react-query" } },
    required: ["package"],
  },
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const error = (t: string): ToolResult => ({ ...text(t), isError: true });

async function readDocs(pkg: unknown): Promise<ToolResult> {
  const project = typeof pkg === "string" ? projectOf(pkg.trim()) : null;
  if (!project || !isProjectName(project)) return error(`"${String(pkg)}" is not an npm package name.`);

  // "@scope/name" is fetched as "@scope%2fname", the registry's form for scoped packages.
  const res = await fetch(`${registry}/${encodeURIComponent(project).replace(/^%40/, "@")}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return error(`The npm registry has no package named ${project}.`);
  if (!res.ok) return error(`The npm registry answered ${res.status} for ${project}.`);

  const readme = ((await res.json()) as { readme?: unknown }).readme;
  if (typeof readme !== "string" || !readme.trim()) return text(`${project} has no README on the npm registry.`);
  return text(readme.length > MAX_README ? `${readme.slice(0, MAX_README)}\n\n[README cut at ${MAX_README} characters]` : readme);
}

type Request = { id?: string | number; method?: string; params?: any };

async function handle({ method, params }: Request): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
  switch (method) {
    case "initialize":
      return {
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "playcount", version: "0.1.0" },
        },
      };
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: [READ_DOCS] } };
    case "tools/call":
      if (params?.name !== READ_DOCS.name) return { error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
      return { result: await readDocs(params?.arguments?.package).catch((e) => error(`Could not reach the npm registry: ${e}`)) };
    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  let req: Request;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  // Notifications (no id) get no answer.
  if (req.id === undefined) return;
  send({ id: req.id, ...(await handle(req)) });
});
