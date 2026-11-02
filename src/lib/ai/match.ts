// Catalogue candidate selection and match verification (pure code, no AI).
import { norm } from "./verify.ts";
import type { MatchOutput, MatchProduct, MatchRequirement } from "./types.ts";

const STOP = new Set(["the", "and", "with", "for", "of", "to", "in", "a", "an", "or", "mm", "per", "as", "be", "is",
  "supply", "install", "including", "all", "type", "توريد", "تركيب", "مع", "من", "في", "على"]);

export function tokens(s: string): string[] {
  return norm(s).split(/[^\p{L}\p{N}.x]+/u).map((t) => t.replace(/^\.+|\.+$/g, ""))
    // "600x600mm" and "600x600 mm" compare equal: drop a unit stuck to a number.
    .map((t) => t.replace(/^(\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)*)(mm|cm|m|kg|l|mm2|m2)$/, "$1"))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function productText(p: MatchProduct) {
  return [p.sku, p.name, p.brand, p.category, p.description, p.variants.join(" "),
    Object.entries(p.specifications).map(([k, v]) => `${k} ${v}`).join(" ")].filter(Boolean).join(" ");
}
function requirementText(r: MatchRequirement) {
  return [r.description, r.specifications, r.requested_brand, Object.values(r.attributes).join(" ")].filter(Boolean).join(" ");
}

/** Similarity 0..1: share of requirement tokens found in the product (numbers and sizes count double). */
export function similarity(r: MatchRequirement, p: MatchProduct): { score: number; shared: string[] } {
  const rt = [...new Set(tokens(requirementText(r)))];
  const pt = new Set(tokens(productText(p)));
  if (rt.length === 0) return { score: 0, shared: [] };
  let got = 0, total = 0;
  const shared: string[] = [];
  for (const t of rt) {
    const w = /\d/.test(t) ? 2 : 1;
    total += w;
    if (pt.has(t)) { got += w; shared.push(t); }
  }
  // Explicit SKU/model mention is a strong signal.
  const skuHit = norm(requirementText(r)).includes(norm(p.sku));
  return { score: Math.min(1, got / total + (skuHit ? 0.5 : 0)), shared };
}

/** Top-N catalogue candidates per requirement, so large catalogues stay within AI limits. */
export function selectCandidates(reqs: MatchRequirement[], products: MatchProduct[], n = 8): Record<string, MatchProduct[]> {
  const out: Record<string, MatchProduct[]> = {};
  for (const r of reqs) {
    out[r.key] = products
      .map((p) => ({ p, s: similarity(r, p).score }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((x) => x.p);
  }
  return out;
}

export type VerifiedMatch = {
  requirementKey: string; productKey: string | null; label: "potential_match" | "alternative" | "no_match";
  similarities: string[]; differences: string[]; missing_evidence: string[];
};

/** Keep only suggestions that point at products we actually offered as candidates. */
export function verifyMatches(out: MatchOutput, reqs: MatchRequirement[], candidates: Record<string, MatchProduct[]>):
  { matches: VerifiedMatch[]; dropped: number } {
  const matches: VerifiedMatch[] = [];
  let dropped = 0;
  const reqKeys = new Set(reqs.map((r) => r.key));
  const seen = new Set<string>();
  for (const m of out.matches) {
    if (!reqKeys.has(m.requirement_key) || seen.has(m.requirement_key)) { dropped++; continue; }
    seen.add(m.requirement_key);
    const allowed = new Set((candidates[m.requirement_key] ?? []).map((p) => p.key));
    const used = new Set<string>();
    for (const c of m.candidates.slice(0, 3)) {
      if (!allowed.has(c.product_key) || used.has(c.product_key)) { dropped++; continue; }
      used.add(c.product_key);
      matches.push({ requirementKey: m.requirement_key, productKey: c.product_key, label: c.label,
        similarities: c.similarities.slice(0, 6), differences: c.differences.slice(0, 6), missing_evidence: c.missing_evidence.slice(0, 6) });
    }
    if (used.size === 0) {
      matches.push({ requirementKey: m.requirement_key, productKey: null, label: "no_match", similarities: [], differences: [],
        missing_evidence: m.no_match_reason ? [m.no_match_reason] : ["No suitable product found in the catalogue."] });
    }
  }
  // Requirements the AI skipped get an explicit "no match" rather than disappearing.
  for (const r of reqs) if (!seen.has(r.key)) matches.push({ requirementKey: r.key, productKey: null, label: "no_match",
    similarities: [], differences: [], missing_evidence: ["Not assessed by the matcher; select a product manually."] });
  return { matches, dropped };
}
