import { describe, expect, it } from "vitest";
import { llmGatewayWeigher, type WeigherInput } from "./weigher.ts";

// A stand-in for the LLM Gateway that records each request and answers with the given content.
function gateway(content: string, status = 200) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status });
  }) as typeof globalThis.fetch;
  return { requests, fetch };
}

const input: WeigherInput = {
  period: "2026-10",
  projects: [
    { project: "zod", import_plays: 4, docs_plays: 1, lines_written: 40 },
    { project: "express", import_plays: 1, docs_plays: 0, lines_written: 2 },
  ],
};

describe("LLM Gateway Weigher", () => {
  it("asks Claude through the gateway with the AssemblyAI key", async () => {
    const g = gateway('{"weights":[]}');
    await llmGatewayWeigher({ apiKey: "aai_key", model: "claude-sonnet-4-6", fetch: g.fetch }).weigh(input);
    expect(g.requests[0].url).toBe("https://llm-gateway.assemblyai.com/v1/chat/completions");
    expect(g.requests[0].headers.authorization).toBe("aai_key");
    expect(g.requests[0].body.model).toBe("claude-sonnet-4-6");
  });

  it("sends Claude the statement's Play-log fields and nothing else (ADR 0001)", async () => {
    const g = gateway('{"weights":[]}');
    const smuggled = {
      ...input,
      transcript: "secret",
      projects: input.projects.map((p) => ({ ...p, session_id: "s1", source: "const x = 1" })),
    } as WeigherInput;
    await llmGatewayWeigher({ apiKey: "k", model: "m", fetch: g.fetch }).weigh(smuggled);
    const messages: { role: string; content: string }[] = g.requests[0].body.messages;
    const user = messages.filter((m) => m.role === "user");
    expect(user).toHaveLength(1);
    expect(JSON.parse(user[0].content)).toEqual(input);
    expect(JSON.stringify(g.requests[0].body)).not.toMatch(/secret|const x|session_id|s1/);
  });

  it("reads Claude's weights and reasons, even inside a code fence", async () => {
    const g = gateway('```json\n{"weights":[{"project":"zod","weight":80,"reason":"Core schemas"},{"project":"express","weight":20,"reason":"One route"}]}\n```');
    const weights = await llmGatewayWeigher({ apiKey: "k", model: "m", fetch: g.fetch }).weigh(input);
    expect(weights).toEqual([
      { project: "zod", weight: 80, reason: "Core schemas" },
      { project: "express", weight: 20, reason: "One route" },
    ]);
  });

  it("fails when the gateway refuses the request or Claude's answer is not JSON", async () => {
    await expect(llmGatewayWeigher({ apiKey: "k", model: "m", fetch: gateway("", 401).fetch }).weigh(input)).rejects.toThrow(/401/);
    await expect(llmGatewayWeigher({ apiKey: "k", model: "m", fetch: gateway("I can't help").fetch }).weigh(input)).rejects.toThrow();
  });
});
