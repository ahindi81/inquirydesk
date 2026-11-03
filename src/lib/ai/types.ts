// Shared AI types and output schemas. Pure module (no server imports) so it can be unit-tested.
import { z } from "zod";

export type DocInput = { index: number; documentId: string | null; name: string; segments: { ref: string; text: string }[] };

// ---------------------------------------------------------------- extraction
export const ExtractedItem = z.object({
  item_no: z.string().nullable(),
  description: z.string(),
  quantity: z.string().nullable().describe("Number exactly as written in the excerpt, or null"),
  unit: z.string().nullable(),
  specifications: z.string().nullable(),
  requested_brand: z.string().nullable(),
  finish: z.string().nullable(),
  colour: z.string().nullable(),
  dimensions: z.string().nullable(),
  delivery_location: z.string().nullable(),
  required_delivery_date: z.string().nullable().describe("YYYY-MM-DD only if a specific date is stated"),
  required_delivery_date_text: z.string().nullable().describe("The date exactly as written in the excerpt"),
  doc: z.number().int().describe("Document index from the <document index=...> tag"),
  ref: z.string().describe("The ref attribute of the first line the item came from"),
  excerpt: z.string().describe("Verbatim text copied from the document that supports this item"),
});
export type ExtractedItem = z.infer<typeof ExtractedItem>;

export const SourcedValue = z.object({
  value: z.string().describe("Normalized value; for dates YYYY-MM-DD"),
  text: z.string().describe("Exactly as written in the document"),
  doc: z.number().int(),
  ref: z.string(),
}).nullable();

export const ExtractionOutput = z.object({
  items: z.array(ExtractedItem),
  quotation_deadline: SourcedValue,
  delivery_location: SourcedValue,
  notes: z.array(z.string()).describe("Problems reading the documents, if any"),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

// ---------------------------------------------------------------- summary
export const SourcedStatement = z.object({ text: z.string(), refs: z.array(z.object({ doc: z.number().int(), ref: z.string() })) });
export const SummaryOutput = z.object({
  overview: z.string().describe("2-4 sentences: what the customer needs, based only on the documents"),
  scope_of_supply: z.array(SourcedStatement),
  deadlines: z.array(SourcedStatement),
  missing_information: z.array(z.string()),
  conflicts: z.array(SourcedStatement).describe("Conflicting or ambiguous requirements, citing both sources"),
  suggested_next_actions: z.array(z.string()),
  clarification_questions: z.array(z.string()),
});
export type SummaryOutput = z.infer<typeof SummaryOutput>;

// ---------------------------------------------------------------- matching
export const MatchOutput = z.object({
  matches: z.array(z.object({
    requirement_key: z.string(),
    candidates: z.array(z.object({
      product_key: z.string().describe("Key of a product from the candidate list, never invented"),
      label: z.enum(["potential_match", "alternative"]),
      similarities: z.array(z.string()),
      differences: z.array(z.string()),
      missing_evidence: z.array(z.string()),
    })),
    no_match_reason: z.string().nullable(),
  })),
});
export type MatchOutput = z.infer<typeof MatchOutput>;

export type MatchRequirement = { key: string; description: string; quantity: string | null; unit: string | null;
  specifications: string | null; requested_brand: string | null; attributes: Record<string, string> };
export type MatchProduct = { key: string; sku: string; name: string; brand: string | null; category: string | null;
  description: string | null; specifications: Record<string, unknown>; unit: string; variants: string[] };

// ---------------------------------------------------------------- provider
export type Usage = { inputTokens?: number; outputTokens?: number };
export class AIError extends Error {
  code: "not_configured" | "quota" | "rate_limited" | "timeout" | "malformed" | "provider_error" | "refused" | "too_large";
  retryable: boolean;
  constructor(code: AIError["code"], message: string, retryable = false) {
    super(message); this.code = code; this.retryable = retryable;
  }
}

export interface AIProvider {
  readonly name: "anthropic" | "openai" | "gemini" | "rules";
  readonly model: string;
  /** false = deterministic rule-based reader, must never be presented as AI. */
  readonly isAI: boolean;
  extract(docs: DocInput[], ctx: { today: string }): Promise<{ output: ExtractionOutput; usage: Usage }>;
  summarize(docs: DocInput[], requirementsJson: string, ctx: { today: string }): Promise<{ output: SummaryOutput; usage: Usage }>;
  match(reqs: MatchRequirement[], candidates: Record<string, MatchProduct[]>): Promise<{ output: MatchOutput; usage: Usage }>;
}
