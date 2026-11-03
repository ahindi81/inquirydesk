import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AIError, ExtractionOutput, MatchOutput, SummaryOutput } from "./types";
import type { AIProvider, DocInput, MatchProduct, MatchRequirement, Usage } from "./types";
import { extractPrompt, matchPrompt, summaryPrompt } from "./prompts";
export { renderDocs } from "./prompts";

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly isAI = true;
  readonly model: string;
  private client: Anthropic;

  constructor() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new AIError("not_configured", "No Anthropic API key is configured on the server.");
    this.model = process.env.AI_MODEL || "claude-sonnet-5-5";
    this.client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 180_000 });
  }

  private async call<T extends z.ZodType>(schema: T, system: string, user: string, maxTokens: number):
    Promise<{ output: z.infer<T>; usage: Usage }> {
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema: z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown> } },
      });
    } catch (e) {
      throw mapError(e);
    }
    const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    if (res.stop_reason === "refusal") throw new AIError("refused", "The AI provider declined to process this content.");
    if (res.stop_reason === "max_tokens") throw new AIError("too_large", "The documents produced more results than fit in one response. Split the inquiry into smaller files.");
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new AIError("malformed", "The AI response was not valid JSON.", true); }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new AIError("malformed", "The AI response did not match the expected format.", true);
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

function mapError(e: unknown): AIError {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AIError("timeout", "The AI provider took too long to respond. Try again.", true);
  if (e instanceof Anthropic.AuthenticationError) return new AIError("not_configured", "The AI provider rejected the API key. Check the key in the server settings.");
  if (e instanceof Anthropic.PermissionDeniedError) return new AIError("not_configured", "The API key does not have access to this model.");
  if (e instanceof Anthropic.RateLimitError) return new AIError("rate_limited", "The AI provider's rate limit was reached. Wait a minute and try again.", true);
  if (e instanceof Anthropic.BadRequestError) {
    const msg = String((e as Error).message);
    if (/credit balance|billing|quota/i.test(msg)) return new AIError("quota", "The AI account has run out of credit. Add credit in the provider's billing console.");
    if (/too long|context|too large/i.test(msg)) return new AIError("too_large", "The documents are too large to process at once. Split them into smaller files.");
    return new AIError("provider_error", "The AI provider rejected the request.");
  }
  if (e instanceof Anthropic.InternalServerError) return new AIError("provider_error", "The AI provider had a temporary problem. Try again shortly.", true);
  if (e instanceof Anthropic.APIConnectionError) return new AIError("provider_error", "Could not reach the AI provider. Check the server's internet connection.", true);
  return new AIError("provider_error", "Unexpected error from the AI provider.", true);
}
