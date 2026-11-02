// Evidence verification. Runs in ordinary code AFTER the AI responds and decides
// what is allowed into the database. The AI is never trusted on its own word:
//  - an item is kept only if its excerpt really appears at the cited location;
//  - each value (quantity, unit, brand, sizes, dates, ...) is kept only if it
//    appears in that excerpt; otherwise it is blanked and flagged.
import type { DocInput, ExtractionOutput, ExtractedItem } from "./types.ts";

// Fields a quotation cannot be finalised without. (Specs often live in the description, so they are not flagged by default.)
export const CLARIFY_FIELDS = ["quantity", "unit", "delivery_location", "required_delivery_date"] as const;

const ARABIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٫": ".", "٬": ",",
};

/** Lower-case, unify digits/diacritics/spacing so "٢٥٠ م²" and "250 م2" compare equal. */
export function norm(s: string): string {
  return s
    .replace(/[٠-٩۰-۹٫٬]/g, (c) => ARABIC_DIGITS[c] ?? c)
    .normalize("NFKC")
    .replace(/[ً-ْـ]/g, "")          // Arabic diacritics + tatweel
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[²]/g, "2").replace(/[³]/g, "3")
    .replace(/[×xX*]/g, "x")
    .toLowerCase()
    .replace(/[|"'`“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Numeric value from "1,250.50" / "١٬٢٥٠٫٥" / "250"; null if not a single clean number. */
export function parseQuantity(s: string | null): string | null {
  if (!s) return null;
  const n = norm(s).replace(/,/g, "");
  const m = /^\d+(\.\d+)?$/.exec(n);
  if (!m) return null;
  const v = Number(n);
  return v > 0 && Number.isFinite(v) ? n.replace(/^0+(?=\d)/, "") : null;
}

function numbersIn(s: string): string[] {
  return (norm(s).replace(/(\d),(\d{3})/g, "$1$2").match(/\d+(\.\d+)?/g) ?? []).map((x) => String(Number(x)));
}

function contains(hay: string, needle: string) {
  const h = norm(hay), n = norm(needle);
  return n.length > 0 && h.includes(n);
}

/** Share of the value's words present in the excerpt (tolerates re-ordering, not invention). */
function wordCoverage(value: string, excerpt: string) {
  const ex = new Set(norm(excerpt).split(/[\s,;:()/\-]+/).filter(Boolean));
  const words = norm(value).split(/[\s,;:()/\-]+/).filter((w) => w.length > 1);
  if (words.length === 0) return 0;
  return words.filter((w) => ex.has(w)).length / words.length;
}

export type VerifiedItem = {
  item_no: string | null; description: string; quantity: string | null; unit: string | null;
  specifications: string | null; requested_brand: string | null; attributes: Record<string, string>;
  delivery_location: string | null; required_delivery_date: string | null;
  doc: number; documentId: string | null; ref: string; excerpt: string;
  needs_clarification: string[]; removed_values: string[]; original: ExtractedItem;
};

export type VerifiedExtraction = {
  items: VerifiedItem[];
  quotationDeadline: { value: string; text: string; doc: number; ref: string } | null;
  deliveryLocation: { value: string; text: string; doc: number; ref: string } | null;
  rejected: { description: string; reason: string }[];
  notes: string[];
};

/** Find the cited segment and its neighbours (an item may span a few lines). */
function evidenceWindow(doc: DocInput | undefined, ref: string): string | null {
  if (!doc) return null;
  const i = doc.segments.findIndex((s) => norm(s.ref) === norm(ref));
  if (i < 0) return null;
  return doc.segments.slice(Math.max(0, i - 2), i + 4).map((s) => s.text).join("\n");
}

export function verifyExtraction(out: ExtractionOutput, docs: DocInput[]): VerifiedExtraction {
  const byIndex = new Map(docs.map((d) => [d.index, d]));
  const items: VerifiedItem[] = [];
  const rejected: VerifiedExtraction["rejected"] = [];

  for (const it of out.items) {
    const doc = byIndex.get(it.doc);
    const window = evidenceWindow(doc, it.ref);
    if (!doc || window === null) { rejected.push({ description: it.description, reason: `cited location "${it.ref}" does not exist` }); continue; }
    if (!it.excerpt?.trim() || !contains(window, it.excerpt)) {
      rejected.push({ description: it.description, reason: `quoted text was not found at ${doc.name}, ${it.ref}` }); continue;
    }
    if (wordCoverage(it.description, it.excerpt) < 0.5) {
      rejected.push({ description: it.description, reason: "description is not supported by the quoted text" }); continue;
    }
    const removed: string[] = [];
    const keepText = (field: string, v: string | null, minCoverage = 0.8): string | null => {
      if (!v?.trim()) return null;
      if (contains(it.excerpt, v) || wordCoverage(v, it.excerpt) >= minCoverage) return v.trim();
      removed.push(field); return null;
    };
    // Quantity: must be a clean number that literally appears in the excerpt.
    let quantity = parseQuantity(it.quantity);
    if (it.quantity && (!quantity || !numbersIn(it.excerpt).includes(String(Number(quantity))))) { removed.push("quantity"); quantity = null; }
    // Date: the as-written text must be in the excerpt and the ISO value must be valid.
    let date: string | null = null;
    if (it.required_delivery_date) {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(it.required_delivery_date) && !isNaN(Date.parse(it.required_delivery_date));
      if (iso && it.required_delivery_date_text && contains(it.excerpt, it.required_delivery_date_text)) date = it.required_delivery_date;
      else removed.push("required_delivery_date");
    }
    const attributes: Record<string, string> = {};
    for (const k of ["finish", "colour", "dimensions"] as const) {
      const v = keepText(k, it[k]);
      if (v) attributes[k] = v;
    }
    const v: VerifiedItem = {
      item_no: keepText("item_no", it.item_no, 1),
      description: it.description.trim(),
      quantity,
      unit: keepText("unit", it.unit, 1),
      specifications: keepText("specifications", it.specifications, 0.7),
      requested_brand: keepText("requested_brand", it.requested_brand, 1),
      attributes,
      delivery_location: keepText("delivery_location", it.delivery_location),
      required_delivery_date: date,
      doc: it.doc, documentId: doc.documentId, ref: it.ref, excerpt: it.excerpt.trim(),
      needs_clarification: [], removed_values: removed, original: it,
    };
    items.push(v);
  }

  // Inquiry-level values must also be found verbatim at their cited location.
  const checkSourced = (s: ExtractionOutput["quotation_deadline"], isDate: boolean) => {
    if (!s) return null;
    const w = evidenceWindow(byIndex.get(s.doc), s.ref);
    if (!w || !contains(w, s.text)) return null;
    if (isDate && !(/^\d{4}-\d{2}-\d{2}$/.test(s.value) && !isNaN(Date.parse(s.value)))) return null;
    return s;
  };
  const quotationDeadline = checkSourced(out.quotation_deadline, true);
  const deliveryLocation = checkSourced(out.delivery_location, false);

  for (const v of items) {
    // A general delivery location applies to every item that doesn't state its own.
    if (!v.delivery_location && deliveryLocation) v.delivery_location = deliveryLocation.value;
    v.needs_clarification = CLARIFY_FIELDS.filter((f) => !v[f]);
  }
  const notes = [...out.notes];
  if (out.quotation_deadline && !quotationDeadline) notes.push("A quotation deadline was suggested but could not be verified in the documents; it was left blank.");
  return { items, quotationDeadline, deliveryLocation, rejected, notes };
}
