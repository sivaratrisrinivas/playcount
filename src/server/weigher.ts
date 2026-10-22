// The Weigher adapter: an AI model behind an OpenAI-style chat completions API, either Groq or
// AssemblyAI's LLM Gateway. It sees a period's statement, which holds Play-log fields only
// (ADR 0001); tests use the fake.
import type { StatementLine } from "./statement.ts";

export type WeigherInput = { period: string; projects: StatementLine[] };
// A relative weight for one Project; PlayCount turns weights into percentage shares.
export type Weight = { project: string; weight: number; reason: string };

export interface Weigher {
  // The model that weighs, shown on the dashboard as the Weighting's proposer.
  model: string;
  weigh(input: WeigherInput): Promise<Weight[]>;
}

const GROQ = "https://api.groq.com/openai/v1/chat/completions";
const GATEWAY = "https://llm-gateway.assemblyai.com/v1/chat/completions";
const TIMEOUT_MS = 30_000;

const INSTRUCTIONS = `You split a developer's monthly open-source budget among the npm projects their coding agent relied on this month.
You get one line per project: import Plays (code the agent wrote that imports it), docs Plays (times the agent read its docs) and lines written against it.
Weigh each project by how much the developer's work actually depended on it, not by raw counts alone: a framework the code is built on outweighs a helper used once.
Answer with JSON only, no prose and no code fences, in this shape:
{"weights":[{"project":"<name>","weight":<number from 0 to 100>,"reason":"<one short line, under 100 characters>"}]}
Include every project you were given, exactly once.`;

// Only the statement's own fields are sent, copied by name, so nothing else can ride along.
export const weigherPrompt = ({ period, projects }: WeigherInput) =>
  JSON.stringify({
    period,
    projects: projects.map(({ project, import_plays, docs_plays, lines_written }) => ({ project, import_plays, docs_plays, lines_written })),
  });

type ChatApi = { url: string; authorization: string; model: string; fetch?: typeof fetch };

function chatWeigher({ url, authorization, model, fetch: fetchFn = fetch }: ChatApi): Weigher {
  return {
    model,
    async weigh(input) {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          // Reasoning models such as gpt-oss spend some of these thinking before they answer.
          max_tokens: 4000,
          messages: [
            { role: "system", content: INSTRUCTIONS },
            { role: "user", content: weigherPrompt(input) },
          ],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error(`${new URL(url).host} sent no message`);
      return parseWeights(content);
    },
  };
}

// AssemblyAI's LLM Gateway takes the AssemblyAI key as is, without "Bearer".
export const llmGatewayWeigher = ({ apiKey, model, fetch }: { apiKey: string; model: string; fetch?: typeof globalThis.fetch }) =>
  chatWeigher({ url: GATEWAY, authorization: apiKey, model, fetch });

// Groq's free tier serves openai/gpt-oss-120b without a payment card; AssemblyAI's free plan
// serves only qwen3.5-4b-32k-fast (both checked Oct 22, 2026). Groq's larger model weighs
// better, so it wins when both keys are set. PLAYCOUNT_WEIGHER_MODEL picks another model.
export function weigherFromEnv(env: Record<string, string | undefined>, fetch?: typeof globalThis.fetch): Weigher | undefined {
  const model = env.PLAYCOUNT_WEIGHER_MODEL || undefined;
  if (env.GROQ_API_KEY) {
    return chatWeigher({ url: GROQ, authorization: `Bearer ${env.GROQ_API_KEY}`, model: model ?? "openai/gpt-oss-120b", fetch });
  }
  if (env.ASSEMBLYAI_API_KEY) return llmGatewayWeigher({ apiKey: env.ASSEMBLYAI_API_KEY, model: model ?? "qwen3.5-4b-32k-fast", fetch });
  return undefined;
}

// Reads the model's answer, tolerating a code fence or a sentence around the JSON.
function parseWeights(content: string): Weight[] {
  const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  const weights = (JSON.parse(json) as { weights?: unknown }).weights;
  if (!Array.isArray(weights)) throw new Error("the model's answer has no weights");
  return weights.map((w) => ({ project: String(w?.project), weight: Number(w?.weight), reason: String(w?.reason ?? "") }));
}

// A Weigher that records what it was asked. By default it weighs by Plays plus lines written.
export function fakeWeigher() {
  const calls: WeigherInput[] = [];
  let answer = (input: WeigherInput): Weight[] | Promise<Weight[]> =>
    input.projects.map((p) => ({
      project: p.project,
      weight: p.import_plays + p.docs_plays + p.lines_written,
      reason: `Relied on ${p.project}`,
    }));
  return {
    model: "fake-model",
    calls,
    respond(next: (input: WeigherInput) => Weight[] | Promise<Weight[]>) {
      answer = next;
    },
    async weigh(input: WeigherInput) {
      calls.push(structuredClone(input));
      return answer(input);
    },
  };
}
