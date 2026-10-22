import { describe, expect, it } from "vitest";
import { llmGatewayWeigher, weigherFromEnv, type WeigherInput } from "./weigher.ts";

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
  it("asks the model through the gateway with the AssemblyAI key", async () => {
    const g = gateway('{"weights":[]}');
    await llmGatewayWeigher({ apiKey: "aai_key", model: "qwen3.5-4b-32k-fast", fetch: g.fetch }).weigh(input);
    expect(g.requests[0].url).toBe("https://llm-gateway.assemblyai.com/v1/chat/completions");
    expect(g.requests[0].headers.authorization).toBe("aai_key");
    expect(g.requests[0].body.model).toBe("qwen3.5-4b-32k-fast");
  });

  it("sends the model the statement's Play-log fields and nothing else (ADR 0001)", async () => {
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

  it("reads the model's weights and reasons, even inside a code fence", async () => {
    const g = gateway('```json\n{"weights":[{"project":"zod","weight":80,"reason":"Core schemas"},{"project":"express","weight":20,"reason":"One route"}]}\n```');
    const weights = await llmGatewayWeigher({ apiKey: "k", model: "m", fetch: g.fetch }).weigh(input);
    expect(weights).toEqual([
      { project: "zod", weight: 80, reason: "Core schemas" },
      { project: "express", weight: 20, reason: "One route" },
    ]);
  });

  it("reads the free Qwen model's real answer, as returned by the gateway on Oct 22, 2026", async () => {
    const content =
      '{\n  "weights": [\n    {\n      "project": "hono",\n      "weight": 90,\n      "reason": "Used significantly more often with 120 lines of code written versus 8 total."\n    },\n    {\n      "project": "zod",\n      "weight": 10,\n      "reason": "Minimal integration with only 2 imports and 8 lines of code written."\n    }\n  ]\n}';
    const weights = await llmGatewayWeigher({ apiKey: "k", model: "m", fetch: gateway(content).fetch }).weigh(input);
    expect(weights.map((w) => [w.project, w.weight])).toEqual([["hono", 90], ["zod", 10]]);
  });

  it("names its model", () => {
    expect(llmGatewayWeigher({ apiKey: "k", model: "qwen3.5-4b-32k-fast" }).model).toBe("qwen3.5-4b-32k-fast");
  });

  it("fails when the gateway refuses the request or the model's answer is not JSON", async () => {
    await expect(llmGatewayWeigher({ apiKey: "k", model: "m", fetch: gateway("", 401).fetch }).weigh(input)).rejects.toThrow(/401/);
    await expect(llmGatewayWeigher({ apiKey: "k", model: "m", fetch: gateway("I can't help").fetch }).weigh(input)).rejects.toThrow();
  });
});

describe("Choosing the Weigher from the environment", () => {
  it("prefers Groq's gpt-oss-120b, sending the key as a Bearer token", async () => {
    const g = gateway('{"weights":[]}');
    const weigher = weigherFromEnv({ GROQ_API_KEY: "gsk_key", ASSEMBLYAI_API_KEY: "aai_key" }, g.fetch)!;
    expect(weigher.model).toBe("openai/gpt-oss-120b");
    await weigher.weigh(input);
    expect(g.requests[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(g.requests[0].headers.authorization).toBe("Bearer gsk_key");
    expect(g.requests[0].body.model).toBe("openai/gpt-oss-120b");
  });

  it("falls back to AssemblyAI's free Qwen model when only that key is set", async () => {
    const g = gateway('{"weights":[]}');
    const weigher = weigherFromEnv({ ASSEMBLYAI_API_KEY: "aai_key" }, g.fetch)!;
    expect(weigher.model).toBe("qwen3.5-4b-32k-fast");
    await weigher.weigh(input);
    expect(g.requests[0].url).toBe("https://llm-gateway.assemblyai.com/v1/chat/completions");
    expect(g.requests[0].headers.authorization).toBe("aai_key");
  });

  it("uses PLAYCOUNT_WEIGHER_MODEL when it is set", () => {
    expect(weigherFromEnv({ GROQ_API_KEY: "k", PLAYCOUNT_WEIGHER_MODEL: "llama-3.3-70b-versatile" })!.model).toBe("llama-3.3-70b-versatile");
  });

  it("is off without a key, so Weightings come from Play counts", () => {
    expect(weigherFromEnv({})).toBeUndefined();
  });

  it("reads the Groq model's real answer from Oct 22, 2026, which carries its reasoning separately", async () => {
    const content =
      '{\n  "weights": [\n    {\n      "project": "hono",\n      "weight": 82.5,\n      "reason": "High usage (multiple imports, docs consulted, and many lines written)"\n    },\n    {\n      "project": "zod",\n      "weight": 17.5,\n      "reason": "Limited usage (single import and minimal code)"\n    }\n  ]\n}';
    const weights = await weigherFromEnv({ GROQ_API_KEY: "k" }, gateway(content).fetch)!.weigh(input);
    expect(weights.map((w) => [w.project, w.weight])).toEqual([["hono", 82.5], ["zod", 17.5]]);
  });
});
