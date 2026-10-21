import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const DOCS_SERVER = fileURLToPath(new URL("./docs-server.ts", import.meta.url));

// A fake npm registry: package name -> packument.
const packuments: Record<string, unknown> = {
  zod: { name: "zod", readme: "# Zod\n\nTypeScript-first schema validation." },
  "@hookform/resolvers": { name: "@hookform/resolvers", readme: "# Resolvers" },
  "no-readme": { name: "no-readme" },
  placeholder: { name: "placeholder", readme: "ERROR: No README data found!" },
  huge: { name: "huge", readme: "x".repeat(50_000) },
};

let registry: Server;
let registryUrl: string;
let child: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();

beforeEach(async () => {
  registry = createServer((req, res) => {
    const name = decodeURIComponent(req.url!.slice(1));
    const body = packuments[name];
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "Not found" }));
  });
  await new Promise<void>((r) => registry.listen(0, "127.0.0.1", r));
  const { port } = registry.address() as { port: number };
  registryUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, [DOCS_SERVER], { env: { ...process.env, PLAYCOUNT_NPM_REGISTRY: registryUrl } });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
});

afterEach(async () => {
  child.kill();
  await new Promise((r) => registry.close(r));
});

function request(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method: string) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

const readDocs = (pkg: unknown) => request("tools/call", { name: "read_docs", arguments: { package: pkg } });

it("introduces itself as the playcount server with tools", async () => {
  const res = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  expect(res.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "playcount" } });
});

it("lists the read_docs tool, which takes a package name", async () => {
  notify("notifications/initialized");
  const res = await request("tools/list");
  expect(res.result.tools).toEqual([
    expect.objectContaining({
      name: "read_docs",
      inputSchema: expect.objectContaining({ required: ["package"] }),
    }),
  ]);
});

it("returns the package README from the npm registry", async () => {
  const res = await readDocs("zod");
  expect(res.result).toEqual({ content: [{ type: "text", text: "# Zod\n\nTypeScript-first schema validation." }] });
});

it("reads scoped packages", async () => {
  const res = await readDocs("@hookform/resolvers");
  expect(res.result.content[0].text).toBe("# Resolvers");
});

it("cuts a very long README short and says so", async () => {
  const res = await readDocs("huge");
  const text: string = res.result.content[0].text;
  expect(text.length).toBeLessThan(20_100);
  expect(text).toMatch(/README cut at 20000 characters/);
});

it("says so when a package has no README", async () => {
  const res = await readDocs("no-readme");
  expect(res.result.isError).toBeUndefined();
  expect(res.result.content[0].text).toMatch(/no README/);
});

it("treats npm's no-README placeholder as no README", async () => {
  const res = await readDocs("placeholder");
  expect(res.result.content[0].text).toMatch(/no README/);
});

it("reports an unknown package as a tool error", async () => {
  const res = await readDocs("no-such-package");
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toMatch(/no-such-package/);
});

it("reports a name that is not an npm package as a tool error", async () => {
  const res = await readDocs("../../etc/passwd");
  expect(res.result.isError).toBe(true);
});

it("answers an unknown method with a JSON-RPC error", async () => {
  const res = await request("resources/list");
  expect(res.error).toMatchObject({ code: -32601 });
});
