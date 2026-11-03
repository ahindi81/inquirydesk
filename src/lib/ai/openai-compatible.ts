// Provider for any service with an OpenAI-compatible Chat Completions API.
// Used for Google Gemini (free tier available). Pure module: no server-only import,
// so it can be tested directly; the API key is only ever passed in from server code.
import { z } from "zod";
import { AIError, ExtractionOutput, MatchOutput, SummaryOutput } from "./types.ts";
import type { AIProvider, DocInput, MatchProduct, MatchRequirement, Usage } from "./types.ts";
import { extractPrompt, matchPrompt, summaryPrompt } from "./prompts.ts";

export type CompatConfig = {
  name: "gemini" | "openai";
  label: string;           // human name for messages, e.g. "Google Gemini"
  baseUrl: string;         // e.g. https://generativelanguage.googleapis.com/v1beta/openai
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch; // for tests
};

type ChatResponse = {
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; status?: string; code?: number | string };
};

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: "gemini" | "openai";
  readonly model: string;
  readonly isAI = true;
  private cfg: CompatConfig;
  /** Set when the service rejects JSON-schema mode; we then fall back to plain JSON mode. */
  private schemaModeUnsupported = false;

  constructor(cfg: CompatConfig) {
    if (!cfg.apiKey) throw new AIError("not_configured", `No ${cfg.label} API key is configured on the server.`);
    this.cfg = { timeoutMs: 180_000, ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, "") };
    this.name = cfg.name;
    this.model = cfg.model;
  }

  private async post(body: Record<string, unknown>): Promise<ChatResponse> {
    const f = this.cfg.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs!),
      });
    } catch (e) {
      const n = (e as Error).name;
      if (n === "TimeoutError" || n === "AbortError") throw new AIError("timeout", `${this.cfg.label} took too long to respond. Try again.`, true);
      throw new AIError("provider_error", `Could not reach ${this.cfg.label}. Check the server's internet connection.`, true);
    }
    let json: ChatResponse = {};
    try { json = (await res.json()) as ChatResponse; } catch { /* non-JSON error body */ }
    if (res.ok) return json;
    const msg = String(json.error?.message ?? (Array.isArray(json) ? (json as { error?: { message?: string } }[])[0]?.error?.message : "") ?? "");
    const label = this.cfg.label;
    if (res.status === 401 || res.status === 403)
      throw new AIError("not_configured", `${label} rejected the API key. Check GEMINI_API_KEY in the server settings.`);
    if (res.status === 429) {
      if (/per ?day|daily|PerDay/i.test(msg))
        throw new AIError("quota", `The ${label} free-tier quota is used up for now. It resets automatically (usually daily); try again later or use a paid key.`);
      throw new AIError("rate_limited", `${label}'s free-tier rate limit was reached. Wait a minute and try again.`, true);
    }
    if (res.status === 400) {
      if (/response_format|json_schema|schema|responseSchema/i.test(msg)) throw new SchemaModeRejected(msg);
      if (/too long|token|context|too large|exceeds/i.test(msg)) throw new AIError("too_large", "The documents are too large to process at once. Split them into smaller files.");
      if (/location is not supported|not available in your country|region/i.test(msg))
        throw new AIError("not_configured", `${label} is not available from the server's location. Try a different hosting region or provider.`);
      throw new AIError("provider_error", `${label} rejected the request.`);
    }
    if (res.status === 404) throw new AIError("not_configured", `${label} does not recognise the model "${this.model}". Check AI_MODEL.`);
    if (res.status >= 500) throw new AIError("provider_error", `${label} had a temporary problem. Try again shortly.`, true);
    throw new AIError("provider_error", `Unexpected error from ${label}.`, true);
  }

  private async call<T extends z.ZodType>(schema: T, system: string, user: string, maxTokens: number):
    Promise<{ output: z.infer<T>; usage: Usage }> {
    const jsonSchema = z.toJSONSchema(schema, { target: "openapi-3.0" }) as Record<string, unknown>;
    const base = { model: this.model, max_tokens: maxTokens, temperature: 0 };
    let res: ChatResponse | undefined;
    if (!this.schemaModeUnsupported) {
      try {
        res = await this.post({ ...base,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          response_format: { type: "json_schema", json_schema: { name: "result", schema: jsonSchema } } });
      } catch (e) {
        if (!(e instanceof SchemaModeRejected)) throw e;
        this.schemaModeUnsupported = true;
      }
    }
    if (!res) {
      // Fallback: plain JSON mode with the schema described in the prompt. The answer
      // is still validated against the schema and checked against the documents.
      res = await this.post({ ...base,
        messages: [
          { role: "system", content: `${system}\n\nReply with a single JSON object that matches this JSON Schema exactly, and nothing else:\n${JSON.stringify(jsonSchema)}` },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" } });
    }
    const choice = res.choices?.[0];
    const usage = { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens };
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter" || choice?.finish_reason === "safety")
      throw new AIError("refused", `${this.cfg.label} declined to process this content.`);
    if (choice?.finish_reason === "length")
      throw new AIError("too_large", "The documents produced more results than fit in one response. Split the inquiry into smaller files.");
    const text = stripFences(choice?.message?.content ?? "");
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new AIError("malformed", "The AI response was not valid JSON. Try again.", true); }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new AIError("malformed", "The AI response did not match the expected format. Try again.", true);
    return { output: parsed.data, usage };
  }

  async extract(docs: DocInput[], ctx: { today: string }) {
    const p = extractPrompt(docs, ctx.today);
    return this.call(ExtractionOutput, p.system, p.user, 32000);
  }
  async summarize(docs: DocInput[], requirementsJson: string, ctx: { today: string }) {
    const p = summaryPrompt(docs, requirementsJson, ctx.today);
    return this.call(SummaryOutput, p.system, p.user, 8000);
  }
  async match(reqs: MatchRequirement[], candidates: Record<string, MatchProduct[]>) {
    const p = matchPrompt(reqs, candidates);
    return this.call(MatchOutput, p.system, p.user, 16000);
  }
}

class SchemaModeRejected extends Error {}

function stripFences(s: string) {
  const t = s.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m ? m[1] : t;
}

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
