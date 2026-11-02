// Deterministic quotation calculator. No AI involved anywhere in this file.
// Rules:
//  - A missing unit price is never treated as zero: the quote is "blocked".
//  - Lines in another currency need an exchange rate the user approved.
//  - Each line total is rounded to the currency's minor units, then summed.
//  - Inquiry requirements not covered by any line are reported as omitted.

import { Dec } from './decimal.ts';

export type MoneyInput = string | number | null | undefined;

export interface QuoteLineInput {
  lineNo: number;
  sku: string;
  description: string;
  quantity: MoneyInput;
  unit: string;
  unitPrice: MoneyInput;          // null/undefined = missing price
  currency: string;
  discountPercent?: MoneyInput;   // 0..100
  requirementId?: string | null;
  lineApproved?: boolean;
}

export interface QuoteInput {
  currency: string;
  taxRatePercent: MoneyInput;     // e.g. 15 for KSA VAT
  freight?: MoneyInput;           // optional, in quote currency
  freightTaxable?: boolean;       // default true
  approvedFx?: Record<string, MoneyInput>; // 1 unit of key currency = rate in quote currency
  lines: QuoteLineInput[];
  requirementIds?: string[];      // all requirements of the inquiry, to detect omissions
}

export type IssueCode =
  | 'missing_price' | 'missing_fx' | 'invalid_quantity' | 'invalid_discount'
  | 'invalid_number' | 'line_not_approved' | 'omitted_requirement' | 'no_lines';

export interface Issue { code: IssueCode; lineNo?: number; requirementId?: string; message: string; blocking: boolean }

export interface LineResult {
  lineNo: number;
  gross: string | null;        // qty × unit price, quote currency
  discount: string | null;
  net: string | null;
  convertedUnitPrice: string | null;
  fxRate: string | null;
}

export interface QuoteResult {
  ok: boolean;                 // false if any blocking issue: totals are then null
  currency: string;
  lines: LineResult[];
  subtotal: string | null;     // sum of line nets
  discountTotal: string | null;
  freight: string | null;
  taxableAmount: string | null;
  tax: string | null;
  total: string | null;
  issues: Issue[];
}

const MINOR_UNITS: Record<string, number> = { BHD: 3, KWD: 3, OMR: 3, JOD: 3, JPY: 0 };
const dpFor = (cur: string) => MINOR_UNITS[cur] ?? 2;

function parse(v: MoneyInput): Dec | null {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  return Dec.from(v);
}

export function calculateQuote(q: QuoteInput, opts: { requireApproval?: boolean } = {}): QuoteResult {
  const issues: Issue[] = [];
  const cur = q.currency.toUpperCase();
  const dp = dpFor(cur);
  const lines: LineResult[] = [];
  let subtotal = Dec.zero;
  let discountTotal = Dec.zero;

  if (q.lines.length === 0) issues.push({ code: 'no_lines', message: 'The quotation has no lines.', blocking: true });

  for (const l of q.lines) {
    const res: LineResult = { lineNo: l.lineNo, gross: null, discount: null, net: null, convertedUnitPrice: null, fxRate: null };
    lines.push(res);
    const bad = (code: IssueCode, message: string) => issues.push({ code, lineNo: l.lineNo, message, blocking: true });

    let qty: Dec | null, price: Dec | null, disc: Dec;
    try {
      qty = parse(l.quantity);
      price = parse(l.unitPrice);
      disc = parse(l.discountPercent) ?? Dec.zero;
    } catch (e) {
      bad('invalid_number', `Line ${l.lineNo}: ${(e as Error).message}`);
      continue;
    }
    if (!qty || qty.cmp(Dec.zero) <= 0) { bad('invalid_quantity', `Line ${l.lineNo} (${l.sku}): quantity must be greater than zero.`); continue; }
    if (disc.isNeg() || disc.cmp(Dec.from(100)) > 0) { bad('invalid_discount', `Line ${l.lineNo} (${l.sku}): discount must be between 0% and 100%.`); continue; }
    if (price === null) { bad('missing_price', `Line ${l.lineNo} (${l.sku}): no approved price. Enter a price or remove the line.`); continue; }
    if (price.isNeg()) { bad('invalid_number', `Line ${l.lineNo} (${l.sku}): price cannot be negative.`); continue; }
    if (opts.requireApproval && !l.lineApproved) bad('line_not_approved', `Line ${l.lineNo} (${l.sku}) has not been approved.`);

    const lineCur = l.currency.toUpperCase();
    let rate = Dec.from(1);
    if (lineCur !== cur) {
      const fx = parse(q.approvedFx?.[lineCur]);
      if (!fx || fx.cmp(Dec.zero) <= 0) {
        bad('missing_fx', `Line ${l.lineNo} (${l.sku}) is priced in ${lineCur}. Approve a ${lineCur}→${cur} exchange rate first.`);
        continue;
      }
      rate = fx;
      res.fxRate = fx.toString();
    }
    const unit = price.mul(rate);
    const gross = qty.mul(unit).round(dp);
    const discount = gross.mul(disc).div(Dec.from(100)).round(dp);
    const net = gross.sub(discount);
    res.convertedUnitPrice = unit.toFixed(Math.max(dp, 4));
    res.gross = gross.toFixed(dp);
    res.discount = discount.toFixed(dp);
    res.net = net.toFixed(dp);
    subtotal = subtotal.add(net);
    discountTotal = discountTotal.add(discount);
  }

  // Requirements that no line covers (warning, not blocking: partial quotes are allowed)
  if (q.requirementIds?.length) {
    const covered = new Set(q.lines.map(l => l.requirementId).filter(Boolean));
    for (const id of q.requirementIds) {
      if (!covered.has(id)) issues.push({ code: 'omitted_requirement', requirementId: id,
        message: 'This inquiry item is not included in the quotation.', blocking: false });
    }
  }

  let freight: Dec | null = null, taxRate: Dec;
  try {
    freight = parse(q.freight);
    taxRate = parse(q.taxRatePercent) ?? Dec.zero;
  } catch (e) {
    issues.push({ code: 'invalid_number', message: (e as Error).message, blocking: true });
    taxRate = Dec.zero;
  }
  if (freight?.isNeg()) issues.push({ code: 'invalid_number', message: 'Freight cannot be negative.', blocking: true });
  if (taxRate.isNeg() || taxRate.cmp(Dec.from(100)) > 0)
    issues.push({ code: 'invalid_number', message: 'Tax rate must be between 0% and 100%.', blocking: true });

  const blocked = issues.some(i => i.blocking);
  if (blocked) {
    return { ok: false, currency: cur, lines, subtotal: null, discountTotal: null, freight: freight?.toFixed(dp) ?? null,
             taxableAmount: null, tax: null, total: null, issues };
  }
  const fr = freight ? freight.round(dp) : Dec.zero;
  const taxable = (q.freightTaxable ?? true) ? subtotal.add(fr) : subtotal;
  const tax = taxable.mul(taxRate).div(Dec.from(100)).round(dp);
  const total = subtotal.add(fr).add(tax);
  return {
    ok: true, currency: cur, lines,
    subtotal: subtotal.toFixed(dp), discountTotal: discountTotal.toFixed(dp),
    freight: freight ? fr.toFixed(dp) : null, taxableAmount: taxable.toFixed(dp),
    tax: tax.toFixed(dp), total: total.toFixed(dp), issues,
  };
}
