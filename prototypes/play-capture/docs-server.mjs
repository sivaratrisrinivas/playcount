#!/usr/bin/env node
// PROTOTYPE: zero-dependency stdio MCP server with one tool, read_docs(package).
import readline from "node:readline";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const tool = {
  name: "read_docs",
  description: "Read the official README/documentation for an npm package. Use this whenever you need docs or API details for a library before using it.",
  inputSchema: { type: "object", properties: { package: { type: "string", description: "npm package name, e.g. zod" } }, required: ["package"] },
};
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === "initialize") return send({ id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "playcount", version: "0.0.0-prototype" } } });
  if (method === "tools/list") return send({ id, result: { tools: [tool] } });
  if (method === "tools/call") {
    const pkg = params?.arguments?.package;
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace("%40", "@")}`);
      const json = await res.json();
      const text = (json.readme || "No README found.").slice(0, 12000);
      return send({ id, result: { content: [{ type: "text", text }] } });
    } catch (e) {
      return send({ id, result: { isError: true, content: [{ type: "text", text: String(e) }] } });
    }
  }
  if (id !== undefined) send({ id, result: {} });
});
