import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../src/lib/ai/openai-compatible.ts";
import { verifyExtraction } from "../src/lib/ai/verify.ts";
import { AIError, type DocInput } from "../src/lib/ai/types.ts";

const docs: DocInput[] = [{ index: 0, documentId: "d1", name: "BOQ.csv", segments: [
  { ref: "row 1", text: "Item | Description | Unit | Qty" },
  { ref: "row 2", text: "1.1 | Porcelain floor tile 600x600 matt | m2 | 1250" },
] }];

const goodOutput = {
  items: [{ item_no: "1.1", description: "Porcelain floor tile 600x600 matt", quantity: "1250", unit: "m2", specifications: null,
    requested_brand: null, finish: "matt", colour: null, dimensions: "600x600", delivery_location: null, required_delivery_date: null,
    required_delivery_date_text: null, doc: 0, ref: "row 2", excerpt: "1.1 | Porcelain floor tile 600x600 matt | m2 | 1250" }],
  quotation_deadline: null, delivery_location: null, notes: [],
};

type Call = { url: string; body: Record<string, unknown>; auth: string };
function fakeFetch(responses: { status: number; body: unknown }[], calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>).Authorization) });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
const provider = (responses: { status: number; body: unknown }[], calls: Call[] = []) => new OpenAICompatibleProvider({
  name: "gemini", label: "Google Gemini", baseUrl: "https://example.test/v1beta/openai/", apiKey: "test-key", model: "gemini-2.5-flash",
  fetchImpl: fakeFetch(responses, calls),
});
const ok = (content: string) => ({ status: 200, body: { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });

test("structured JSON answer is parsed and passes evidence checks", async () => {
  const calls: Call[] = [];
  const r = await provider([ok(JSON.stringify(goodOutput))], calls).extract(docs, { today: "2026-11-03" });
  assert.equal(calls[0].url, "https://example.test/v1beta/openai/chat/completions");
  assert.equal(calls[0].auth, "Bearer test-key");
  assert.equal((calls[0].body.response_format as { type: string }).type, "json_schema");
  assert.equal(calls[0].body.model, "gemini-2.5-flash");
  const v = verifyExtraction(r.output, docs);
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].quantity, "1250");
  assert.equal(r.usage.inputTokens, 10);
});

test("falls back to plain JSON mode when schema mode is rejected", async () => {
  const calls: Call[] = [];
  const p = provider([{ status: 400, body: { error: { message: "Invalid JSON payload: response_format.json_schema unsupported field" } } },
    ok("```json\n" + JSON.stringify(goodOutput) + "\n```")], calls);
  const r = await p.extract(docs, { today: "2026-11-03" });
  assert.equal(calls.length, 2);
  assert.equal((calls[1].body.response_format as { type: string }).type, "json_object");
  assert.match(String((calls[1].body.messages as { content: string }[])[0].content), /JSON Schema/);
  assert.equal(r.output.items.length, 1);
});

for (const [name, resp, code] of [
  ["rate limit → retryable message", { status: 429, body: { error: { message: "Resource has been exhausted (e.g. check quota). requests per minute" } } }, "rate_limited"],
  ["daily quota → quota message", { status: 429, body: { error: { message: "You exceeded your current quota: requests per day" } } }, "quota"],
  ["bad key → not configured", { status: 401, body: { error: { message: "API key not valid" } } }, "not_configured"],
  ["unknown model → not configured", { status: 404, body: { error: { message: "models/x is not found" } } }, "not_configured"],
  ["server error → provider error", { status: 503, body: {} }, "provider_error"],
] as const) {
  test(name, async () => {
    await assert.rejects(provider([resp]).extract(docs, { today: "2026-11-03" }), (e: unknown) => e instanceof AIError && e.code === code);
  });
}

test("malformed or wrong-shaped answers are rejected, not guessed", async () => {
  await assert.rejects(provider([ok("not json at all")]).extract(docs, { today: "x" }), (e: unknown) => e instanceof AIError && e.code === "malformed");
  await assert.rejects(provider([ok(JSON.stringify({ items: "nope" }))]).extract(docs, { today: "x" }), (e: unknown) => e instanceof AIError && e.code === "malformed");
});

test("truncated answer is reported as too large", async () => {
  const resp = { status: 200, body: { choices: [{ message: { content: "{" }, finish_reason: "length" }] } };
  await assert.rejects(provider([resp]).extract(docs, { today: "x" }), (e: unknown) => e instanceof AIError && e.code === "too_large");
});

test("missing key is reported clearly", () => {
  assert.throws(() => new OpenAICompatibleProvider({ name: "gemini", label: "Google Gemini", baseUrl: "x", apiKey: "", model: "m" }),
    (e: unknown) => e instanceof AIError && e.code === "not_configured");
});
