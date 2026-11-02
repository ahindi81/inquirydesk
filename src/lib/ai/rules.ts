// Rule-based reader: deterministic, NO AI. Used for demo mode and when no AI
// provider is configured. Reads tables (Excel/CSV BOQs) and simple "250 m2 tile"
// lines. Everything it produces still goes through verify.ts.
import type { AIProvider, DocInput, ExtractedItem, ExtractionOutput, MatchOutput, MatchProduct, MatchRequirement, SummaryOutput } from "./types.ts";
import { norm } from "./verify.ts";
import { similarity, tokens } from "./match.ts";

const H = {
  desc: /^(description|item description|desc|product|material|scope|specification|وصف|الوصف|البيان|بيان الأعمال|المادة)$/,
  qty: /^(qty|qty\.|quantity|quantities|qnty|الكمية|الكميه|كمية)$/,
  unit: /^(unit|units|uom|u\/m|الوحدة|الوحده|وحدة)$/,
  item: /^(item|item no|item no\.|no|no\.|s\/n|sn|#|ref|البند|رقم البند|م|رقم)$/,
  brand: /^(brand|make|manufacturer|model|الماركة|العلامة التجارية|الموديل)$/,
  spec: /^(specification|specifications|spec|technical specification|المواصفات)$/,
};
const UNITS = "m2|m²|sqm|sq\\.?m|m3|lm|rm|m|pcs|pc|nos|no\\.?|units?|sets?|kg|tons?|rolls?|boxes|box|lot|ls|each|ea|م2|م²|م\\.ط|م|عدد|قطعة|طقم|كجم";

function splitCells(text: string) { return text.split(" | ").map((c) => c.trim()); }

function findHeader(cells: string[]) {
  const n = cells.map((c) => norm(c).replace(/[:]/g, ""));
  const col = (re: RegExp) => n.findIndex((c) => re.test(c));
  const h = { desc: col(H.desc), qty: col(H.qty), unit: col(H.unit), item: col(H.item), brand: col(H.brand), spec: col(H.spec) };
  if (h.spec === h.desc) h.spec = -1;
  return h.desc >= 0 && h.qty >= 0 ? h : null;
}

function tableItems(doc: DocInput): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  let header: ReturnType<typeof findHeader> = null;
  let headerSheet = "";
  for (const seg of doc.segments) {
    const sheet = seg.ref.includes("!") ? seg.ref.split("!")[0] : "";
    if (header && sheet !== headerSheet) header = null;
    const cells = splitCells(seg.text);
    const h = findHeader(cells);
    if (h) { header = h; headerSheet = sheet; continue; }
    if (!header) continue;
    const desc = cells[header.desc] ?? "";
    const qty = cells[header.qty] ?? "";
    if (!desc || desc.length < 3) continue;
    items.push(blank({
      item_no: header.item >= 0 ? cells[header.item] || null : null,
      description: desc,
      quantity: qty || null,
      unit: header.unit >= 0 ? cells[header.unit] || null : null,
      requested_brand: header.brand >= 0 ? cells[header.brand] || null : null,
      specifications: header.spec >= 0 ? cells[header.spec] || null : null,
      dimensions: (desc.match(/\d+\s*[x×*]\s*\d+(\s*[x×*]\s*\d+)?\s*(mm|cm|m)?/i) ?? [null])[0],
      doc: doc.index, ref: seg.ref, excerpt: seg.text,
    }));
  }
  return items;
}

function lineItems(doc: DocInput): ExtractedItem[] {
  const re = new RegExp(`^(?:[-•*]|\\d+[.)])?\\s*([\\d٠-٩][\\d٠-٩,.٬٫]*)\\s*(${UNITS})\\b\\.?\\s+(?:of\\s+|من\\s+)?(.{3,})$`, "i");
  const items: ExtractedItem[] = [];
  for (const seg of doc.segments) {
    const m = re.exec(seg.text);
    if (!m) continue;
    const desc = m[3].replace(/[.;,]$/, "").trim();
    items.push(blank({ description: desc, quantity: m[1], unit: m[2], doc: doc.index, ref: seg.ref, excerpt: seg.text,
      dimensions: (desc.match(/\d+\s*[x×*]\s*\d+(\s*[x×*]\s*\d+)?\s*(mm|cm|m)?/i) ?? [null])[0] }));
  }
  return items;
}

function blank(o: Partial<ExtractedItem>): ExtractedItem {
  return { item_no: null, description: "", quantity: null, unit: null, specifications: null, requested_brand: null, finish: null,
    colour: null, dimensions: null, delivery_location: null, required_delivery_date: null, required_delivery_date_text: null,
    doc: 0, ref: "", excerpt: "", ...o };
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** Find a date in text; returns as-written text and ISO value. Day-first for numeric dates (KSA convention). */
export function findDate(text: string): { text: string; value: string } | null {
  const t = norm(text);
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return mk(m[0], +m[1], +m[2], +m[3]);
  m = /(\d{1,2})\s*(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})/.exec(t);
  if (m) return mk(m[0], +m[3], MONTHS[m[2]], +m[1]);
  m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(t);
  if (m) return mk(m[0], +m[3], MONTHS[m[1]], +m[2]);
  m = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(t);
  if (m) return mk(m[0], +m[3], +m[2], +m[1]);
  return null;
  function mk(raw: string, y: number, mo: number, d: number) {
    if (!y || !mo || mo > 12 || !d || d > 31) return null;
    // `raw` is from normalized text; return the original-text slice when possible.
    const value = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return isNaN(Date.parse(value)) ? null : { text: raw, value };
  }
}

function inquiryLevel(docs: DocInput[]) {
  let deadline: ExtractionOutput["quotation_deadline"] = null;
  let location: ExtractionOutput["delivery_location"] = null;
  for (const d of docs) for (const s of d.segments) {
    const t = norm(s.text);
    if (!deadline && /(quot|tender|offer|proposal|bid|عرض|المناقصة|العطاء).{0,40}(due|deadline|before|by|closing|submit|no later|موعد|قبل|آخر)/.test(t)) {
      const dt = findDate(s.text);
      if (dt) deadline = { value: dt.value, text: dt.text, doc: d.index, ref: s.ref };
    }
    if (!location) {
      const m = /(?:deliver(?:y|ed)?\s+(?:to|at)|delivery location:?|site location:?|التوريد إلى|التسليم في)\s+([^,.;|\n]{3,60})/i.exec(s.text);
      if (m) location = { value: m[1].trim(), text: m[1].trim(), doc: d.index, ref: s.ref };
    }
  }
  return { deadline, location };
}

export class RulesProvider implements AIProvider {
  readonly name = "rules" as const;
  readonly model = "rule-based-v1";
  readonly isAI = false;

  async extract(docs: DocInput[]) {
    const items = docs.flatMap((d) => { const t = tableItems(d); return t.length ? t : lineItems(d); });
    const { deadline, location } = inquiryLevel(docs);
    const notes: string[] = [];
    if (items.length === 0) notes.push("The rule-based reader found no table with Description and Quantity columns, and no lines like \"250 m2 porcelain tile\". Add requirements manually or configure an AI provider.");
    return { output: { items, quotation_deadline: deadline, delivery_location: location, notes }, usage: {} };
  }

  async summarize(docs: DocInput[], requirementsJson: string): Promise<{ output: SummaryOutput; usage: object }> {
    const reqs = JSON.parse(requirementsJson) as { item_no: string | null; description: string; quantity: string | null; unit: string | null;
      ref: string | null; doc: number | null; needs_clarification: string[]; quotation_deadline?: string }[];
    const missing = new Map<string, string[]>();
    for (const r of reqs) for (const f of r.needs_clarification) missing.set(f, [...(missing.get(f) ?? []), r.item_no ?? r.description.slice(0, 30)]);
    const label: Record<string, string> = { quantity: "Quantity", unit: "Unit", specifications: "Technical specifications",
      delivery_location: "Delivery location", required_delivery_date: "Required delivery date" };
    const { deadline } = inquiryLevel(docs);
    return {
      output: {
        overview: `${reqs.length} line item(s) were read from ${docs.length} document(s) by the rule-based reader. This is a structured listing, not an AI interpretation.`,
        scope_of_supply: reqs.map((r) => ({ text: `${r.item_no ? r.item_no + " — " : ""}${r.description}${r.quantity ? ` — ${r.quantity} ${r.unit ?? ""}` : ""}`.trim(),
          refs: r.ref && r.doc !== null ? [{ doc: r.doc, ref: r.ref }] : [] })),
        deadlines: deadline ? [{ text: `Quotation due ${deadline.value}`, refs: [{ doc: deadline.doc, ref: deadline.ref }] }] : [],
        missing_information: [...missing].map(([f, items]) => `${label[f] ?? f} not stated for ${items.length} item(s): ${items.slice(0, 8).join(", ")}${items.length > 8 ? "…" : ""}`),
        conflicts: [],
        suggested_next_actions: ["Review the extracted items against the source documents.", ...(missing.size ? ["Send the clarification email for missing details."] : []), "Run product matching."],
        clarification_questions: [...missing].map(([f, items]) => `Please confirm the ${(label[f] ?? f).toLowerCase()} for item(s) ${items.slice(0, 8).join(", ")}.`),
      },
      usage: {},
    };
  }

  async match(reqs: MatchRequirement[], candidates: Record<string, MatchProduct[]>): Promise<{ output: MatchOutput; usage: object }> {
    return {
      output: {
        matches: reqs.map((r) => {
          const scored = (candidates[r.key] ?? []).map((p) => ({ p, ...similarity(r, p) })).sort((a, b) => b.score - a.score);
          const picks = scored.filter((s) => s.score >= 0.3).slice(0, 2);
          return {
            requirement_key: r.key,
            candidates: picks.map((s, i) => {
              const reqNums = tokens(`${r.description} ${r.specifications ?? ""}`).filter((t) => /\d/.test(t));
              const prodTokens = new Set(tokens(`${s.p.name} ${s.p.description ?? ""} ${JSON.stringify(s.p.specifications)}`));
              return {
                product_key: s.p.key,
                label: i === 0 && s.score >= 0.6 ? "potential_match" as const : "alternative" as const,
                similarities: s.shared.length ? [`Shared terms: ${s.shared.slice(0, 8).join(", ")}`] : [],
                differences: reqNums.filter((n) => !prodTokens.has(n)).map((n) => `"${n}" in the requirement is not in the product data`),
                missing_evidence: ["Rule-based word comparison only: technical compliance has not been assessed."],
              };
            }),
            no_match_reason: picks.length ? null : "No catalogue product shares enough terms with this requirement.",
          };
        }),
      },
      usage: {},
    };
  }
}
