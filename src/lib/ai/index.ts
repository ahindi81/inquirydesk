import "server-only";
import { AIError, type AIProvider } from "./types";
import { RulesProvider } from "./rules";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider, GEMINI_BASE_URL, GEMINI_DEFAULT_MODEL } from "./openai-compatible";

export type ProviderStatus = { name: string; isAI: boolean; label: string; configured: boolean; problem?: string };

/**
 * Which engine processes inquiries. Demo workspaces always use the rule-based
 * reader so demo results are never presented as live AI processing.
 */
export function getProvider(opts: { demo: boolean }): AIProvider {
  if (opts.demo) return new RulesProvider();
  const p = (process.env.AI_PROVIDER ?? "").toLowerCase();
  if (p === "anthropic") return new AnthropicProvider();
  if (p === "gemini") return new OpenAICompatibleProvider({
    name: "gemini", label: "Google Gemini", baseUrl: process.env.AI_BASE_URL || GEMINI_BASE_URL,
    apiKey: process.env.GEMINI_API_KEY ?? "", model: process.env.AI_MODEL || GEMINI_DEFAULT_MODEL,
  });
  if (p === "openai") throw new AIError("not_configured", "OpenAI support is planned but not implemented yet. Set AI_PROVIDER to anthropic or gemini.");
  return new RulesProvider();
}

export function providerStatus(opts: { demo: boolean }): ProviderStatus {
  if (opts.demo) return { name: "rules", isAI: false, configured: true, label: "Demo mode — rule-based reader, no AI" };
  try {
    const p = getProvider(opts);
    return p.isAI
      ? { name: p.name, isAI: true, configured: true, label: `AI: ${p.name} (${p.model})${p.name === "gemini" && !process.env.AI_PAID_TIER ? " — free tier: use test data only" : ""}` }
      : { name: "rules", isAI: false, configured: false, label: "No AI provider configured — rule-based reader only" };
  } catch (e) {
    return { name: process.env.AI_PROVIDER ?? "none", isAI: false, configured: false, label: "AI provider not available", problem: (e as Error).message };
  }
}
