// Catalogue import validation (pure; unit-tested). Turns raw spreadsheet rows +
// a column mapping into clean product records, reporting every problem by row.
import { Dec } from "./quote/decimal.ts";

export const PRODUCT_FIELDS = [
  { key: "sku", label: "SKU / product code", required: true },
  { key: "name", label: "Product name", required: true },
  { key: "brand", label: "Brand" },
  { key: "category", label: "Category" },
  { key: "description", label: "Description" },
  { key: "specifications", label: "Technical specifications" },
  { key: "unit", label: "Unit of measure", required: true },
  { key: "variants", label: "Variants / finishes" },
  { key: "unit_price", label: "Approved unit selling price" },
  { key: "currency", label: "Currency" },
  { key: "lead_time_days", label: "Lead time (days)" },
] as const;
export type ProductFieldKey = (typeof PRODUCT_FIELDS)[number]["key"];
export type Mapping = Partial<Record<ProductFieldKey, number>>; // field -> column index

export type CleanProduct = {
  sku: string; name: string; brand: string | null; category: string | null; description: string | null;
  specifications: Record<string, string>; unit: string; variants: string[];
  unit_price: string | null; currency: string | null; lead_time_days: number | null;
};

const GUESS: Record<ProductFieldKey, RegExp> = {
  sku: /^(sku|code|item code|product code|part no|part number|article|ref|رمز|كود)/i,
  name: /^(name|product name|product|item name|title|اسم|المنتج)/i,
  brand: /^(brand|make|manufacturer|الماركة)/i,
  category: /^(category|group|family|الفئة)/i,
  description: /^(description|desc|details|الوصف)/i,
  specifications: /^(spec|specs|specification|technical|المواصفات)/i,
  unit: /^(unit|uom|unit of measure|الوحدة)/i,
  variants: /^(variant|variants|finish|finishes|colou?rs?|options)/i,
  unit_price: /^(price|unit price|selling price|rate|سعر|السعر)/i,
  currency: /^(currency|curr|ccy|العملة)/i,
  lead_time_days: /^(lead|lead time|delivery days)/i,
};

export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  const used = new Set<number>();
  for (const f of PRODUCT_FIELDS) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && GUESS[f.key].test(h.trim()));
    if (i >= 0) { m[f.key] = i; used.add(i); }
  }
  return m;
}

/** "size: 600x600; finish: matt" or "size=600x600 | finish=matt" -> object. Free text goes under "notes". */
export function parseSpecs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const free: string[] = [];
  for (const part of s.split(/[;|\n]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^([^:=]{1,40})[:=]\s*(.+)$/.exec(part);
    if (m) out[m[1].trim().toLowerCase().replace(/\s+/g, "_")] = m[2].trim();
    else free.push(part);
  }
  if (free.length) out.notes = free.join("; ");
  return out;
}

export type RowError = { row: number; message: string };

export function validateRows(rows: string[][], mapping: Mapping, defaultCurrency: string, firstDataRow = 2):
  { products: CleanProduct[]; errors: RowError[] } {
  const missing = PRODUCT_FIELDS.filter((f) => "required" in f && f.required && mapping[f.key] === undefined);
  if (missing.length) return { products: [], errors: [{ row: 0, message: `Map a column for: ${missing.map((f) => f.label).join(", ")}.` }] };
  const get = (r: string[], k: ProductFieldKey) => (mapping[k] === undefined ? "" : String(r[mapping[k]!] ?? "").trim());
  const products: CleanProduct[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const rowNo = i + firstDataRow;
    if (r.every((c) => !String(c ?? "").trim())) return; // blank row
    const problems: string[] = [];
    const sku = get(r, "sku"), name = get(r, "name"), unit = get(r, "unit");
    if (!sku) problems.push("SKU is empty");
    if (!name) problems.push("product name is empty");
    if (!unit) problems.push("unit is empty");
    if (sku && seen.has(sku.toUpperCase())) problems.push(`SKU ${sku} also appears on row ${seen.get(sku.toUpperCase())}`);
    let price: string | null = null;
    const rawPrice = get(r, "unit_price").replace(/[^\d.,\-]/g, "");
    if (get(r, "unit_price")) {
      try {
        const d = Dec.from(rawPrice.replace(/,/g, ""));
        if (d.isNeg()) problems.push("price is negative"); else price = d.toFixed(4).replace(/\.?0+$/, "") || "0";
      } catch { problems.push(`price "${get(r, "unit_price")}" is not a number`); }
    }
    let currency: string | null = get(r, "currency").toUpperCase() || null;
    if (price !== null && !currency) currency = defaultCurrency;
    if (currency && !/^[A-Z]{3}$/.test(currency)) problems.push(`currency "${currency}" must be a 3-letter code like SAR or USD`);
    let lead: number | null = null;
    if (get(r, "lead_time_days")) {
      const n = Number(get(r, "lead_time_days"));
      if (!Number.isInteger(n) || n < 0) problems.push("lead time must be a whole number of days"); else lead = n;
    }
    if (problems.length) { errors.push({ row: rowNo, message: problems.join("; ") }); return; }
    seen.set(sku.toUpperCase(), rowNo);
    products.push({
      sku, name, unit,
      brand: get(r, "brand") || null, category: get(r, "category") || null, description: get(r, "description") || null,
      specifications: get(r, "specifications") ? parseSpecs(get(r, "specifications")) : {},
      variants: get(r, "variants") ? get(r, "variants").split(/[,;/|]/).map((v) => v.trim()).filter(Boolean) : [],
      unit_price: price, currency: price === null ? (currency ?? null) : currency, lead_time_days: lead,
    });
  });
  return { products, errors };
}
