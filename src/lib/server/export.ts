import "server-only";
import path from "node:path";
import type { QuoteResult } from "@/lib/quote/calculate";

export type ExportData = {
  company: { name: string; legal_name: string | null; address: string | null; phone: string | null; email: string | null; website: string | null; tax_number: string | null; is_demo: boolean };
  customer: { name: string; project: string | null; reference: string | null };
  rev: { quote_number: string; revision_no: number; status: string; quote_date: string; currency: string; tax_rate: string; validity_days: number | null;
    delivery_terms: string | null; payment_terms: string | null; exclusions: string | null; notes: string | null; approved_fx: Record<string, string> };
  lines: { line_no: number; sku: string; description: string; quantity: string | null; unit: string; unit_price: string | null; currency: string; discount_percent: string }[];
  calc: QuoteResult;
  preparedBy: string | null;
};

const q = (v: string | null) => (v === null ? "" : v.includes(".") ? v.replace(/\.?0+$/, "") : v);
function money(v: string | null) {
  if (v === null) return "—";
  const [i, f] = v.split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f !== undefined ? "." + f : "");
}
/** Unit prices: at least 2 decimals, keep up to 4 if present (78.5 -> 78.50, 1.2345 stays). */
const price2 = (v: string | null) => { if (v === null) return null; const [i, f = ""] = q(v).split("."); return `${i}.${f.padEnd(2, "0")}`; };
const hasArabic = (s: string) => /[؀-ۿ]/.test(s);

function fileBase(d: ExportData) { return `${d.rev.quote_number}-rev${d.rev.revision_no}${d.rev.status === "approved" ? "" : "-DRAFT"}`; }

// ---------------------------------------------------------------- CSV
export function toCsv(d: ExportData): { body: Buffer; name: string } {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [["Line", "SKU", "Description", "Quantity", "Unit", "Unit price", "Price currency", "Discount %", `Net (${d.calc.currency})`]];
  for (const l of d.lines) {
    const c = d.calc.lines.find((x) => x.lineNo === l.line_no);
    rows.push([String(l.line_no), l.sku, l.description, q(l.quantity), l.unit, q(l.unit_price), l.currency, q(l.discount_percent), c?.net ?? ""]);
  }
  // UTF-8 BOM so Excel shows Arabic correctly.
  return { body: Buffer.from("﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n", "utf8"), name: `${fileBase(d)}.csv` };
}

// ---------------------------------------------------------------- Excel
export async function toXlsx(d: ExportData): Promise<{ body: Buffer; name: string }> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Quotation");
  ws.addRow([`${d.company.name} — Quotation ${d.rev.quote_number} Rev ${d.rev.revision_no}${d.rev.status === "approved" ? "" : " (DRAFT — not approved)"}`]).font = { bold: true, size: 13 };
  ws.addRow([`Customer: ${d.customer.name}`, d.customer.project ? `Project: ${d.customer.project}` : ""]);
  ws.addRow([`Date: ${d.rev.quote_date}`, `Currency: ${d.calc.currency}`]);
  ws.addRow([]);
  const header = ws.addRow(["Line", "SKU", "Description", "Quantity", "Unit", "Unit price", "Price currency", "Discount %", `Net (${d.calc.currency})`]);
  header.font = { bold: true };
  for (const l of d.lines) {
    const c = d.calc.lines.find((x) => x.lineNo === l.line_no);
    // Numbers are written as numbers for Excel; exact values come from the decimal calculator.
    ws.addRow([l.line_no, l.sku, l.description, l.quantity === null ? null : Number(l.quantity), l.unit, l.unit_price === null ? null : Number(l.unit_price),
      l.currency, Number(l.discount_percent), c?.net ? Number(c.net) : null]);
  }
  ws.addRow([]);
  const tot = (label: string, v: string | null) => { const r = ws.addRow(["", "", "", "", "", "", "", label, v === null ? "—" : Number(v)]); r.getCell(8).font = { bold: true }; };
  tot("Subtotal", d.calc.subtotal);
  if (d.calc.freight) tot("Freight", d.calc.freight);
  tot(`Tax ${q(d.rev.tax_rate)}%`, d.calc.tax);
  tot("Total", d.calc.total);
  ws.columns.forEach((c, i) => { c.width = [6, 16, 50, 10, 8, 12, 10, 12, 16][i] ?? 12; });
  [4, 6, 9].forEach((i) => { ws.getColumn(i).numFmt = "#,##0.00##"; });
  ws.getColumn(3).alignment = { wrapText: true, vertical: "top" };
  return { body: Buffer.from(await wb.xlsx.writeBuffer()), name: `${fileBase(d)}.xlsx` };
}

// ---------------------------------------------------------------- PDF
export async function toPdf(d: ExportData): Promise<{ body: Buffer; name: string }> {
  const PDFDocument = (await import("pdfkit")).default;
  const fontDir = path.join(process.cwd(), "assets", "fonts");
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Quotation ${d.rev.quote_number}`, Author: d.company.name } });
  doc.registerFont("Regular", path.join(fontDir, "DejaVuSans.ttf"));
  doc.registerFont("Bold", path.join(fontDir, "DejaVuSans-Bold.ttf"));
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((res) => doc.on("end", () => res()));

  const W = doc.page.width - 80;
  const navy = "#0f2a38", green = "#24804f", gray = "#5b6b73";
  // Arabic runs are drawn right-aligned so they read naturally; fontkit handles letter shaping.
  const text = (s: string, x: number, y: number, o: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}) => {
    doc.font(o.font ?? "Regular").fontSize(o.size ?? 9).fillColor(o.color ?? "#17242b");
    // The PDF engine lays out all-Arabic lines right-to-left including digit groups; pre-reverse
    // digit groups so numbers such as ٦٠٠×٦٠٠ print in the right order.
    if (hasArabic(s) && !/[A-Za-z]/.test(s)) s = s.replace(/[0-9٠-٩](?:[0-9٠-٩.,٫٬×x/-]*[0-9٠-٩])?/g, (m) => [...m].reverse().join(""));
    doc.text(s, x, y, { ...o, align: o.align ?? (hasArabic(s) && !/[A-Za-z]{3}/.test(s) ? "right" : "left"), features: hasArabic(s) ? ["rlig", "calt", "liga"] : undefined });
  };

  if (d.rev.status !== "approved" || d.company.is_demo) {
    doc.save().rotate(-30, { origin: [300, 420] }).font("Bold").fontSize(60).fillColor("#d9534f").opacity(0.12)
      .text(d.company.is_demo ? "DEMO" : "DRAFT", 100, 380, { width: 400, align: "center" }).restore().opacity(1);
  }
  // Header
  text(d.company.name, 40, 40, { font: "Bold", size: 16, color: navy, width: W * 0.6 });
  const contact = [d.company.legal_name, d.company.address, [d.company.phone, d.company.email].filter(Boolean).join(" · "), d.company.website,
    d.company.tax_number ? `VAT/Tax no. ${d.company.tax_number}` : null].filter(Boolean).join("\n");
  doc.font("Bold").fontSize(16);
  const nameH = doc.heightOfString(d.company.name, { width: W * 0.6 });
  text(contact, 40, 44 + nameH, { size: 8, color: gray, width: W * 0.6 });
  doc.font("Regular").fontSize(8);
  const headerBottom = 44 + nameH + doc.heightOfString(contact || " ", { width: W * 0.6 });
  text("QUOTATION", 40 + W * 0.6, 40, { font: "Bold", size: 16, color: green, width: W * 0.4, align: "right" });
  text(`No. ${d.rev.quote_number}  ·  Rev ${d.rev.revision_no}\nDate ${d.rev.quote_date}${d.rev.validity_days ? `\nValid for ${d.rev.validity_days} days` : ""}${d.rev.status === "approved" ? "" : "\nDRAFT — not approved"}`,
    40 + W * 0.6, 62, { size: 9, width: W * 0.4, align: "right" });
  let y = Math.max(135, headerBottom + 12);
  doc.moveTo(40, y).lineTo(40 + W, y).strokeColor("#e2e7ea").stroke();
  y += 10;
  text("To", 40, y, { font: "Bold", size: 8, color: gray });
  text(d.customer.name, 40, y + 11, { font: "Bold", size: 10, width: W * 0.5, align: "left" });
  text([d.customer.project ? `Project: ${d.customer.project}` : null, d.customer.reference ? `Your ref.: ${d.customer.reference}` : null].filter(Boolean).join("\n"),
    40, y + 25, { size: 9, width: W * 0.6, align: "left" });
  y += 60;

  // Table
  const cols = [{ k: "#", w: 22 }, { k: "Code", w: 70 }, { k: "Description", w: 190 }, { k: "Qty", w: 45, r: true }, { k: "Unit", w: 32 },
    { k: "Unit price", w: 62, r: true }, { k: "Disc.", w: 32, r: true }, { k: `Net ${d.calc.currency}`, w: W - 453, r: true }];
  const drawHeader = () => {
    doc.rect(40, y, W, 18).fill(navy);
    let x = 40;
    for (const c of cols) { text(c.k, x + 3, y + 5, { font: "Bold", size: 8, color: "#ffffff", width: c.w - 6, align: c.r ? "right" : "left" }); x += c.w; }
    y += 22;
  };
  drawHeader();
  for (const l of d.lines) {
    const c = d.calc.lines.find((x) => x.lineNo === l.line_no);
    const desc = l.description + (l.currency !== d.calc.currency && c?.fxRate ? `\n(${q(l.unit_price)} ${l.currency} @ ${c.fxRate})` : "");
    doc.font("Regular").fontSize(8.5);
    const h = Math.max(14, doc.heightOfString(desc, { width: cols[2].w - 6 }) + 6);
    if (y + h > doc.page.height - 120) { doc.addPage(); y = 40; drawHeader(); }
    const vals = [String(l.line_no), l.sku, desc, q(l.quantity) || "—", l.unit, money(price2(c?.convertedUnitPrice ?? l.unit_price)),
      Number(l.discount_percent) ? `${q(l.discount_percent)}%` : "", money(c?.net ?? null)];
    let x = 40;
    vals.forEach((v, i) => { text(v, x + 3, y + 2, { size: 8.5, width: cols[i].w - 6, align: cols[i].r ? "right" : hasArabic(v) ? "right" : "left" }); x += cols[i].w; });
    y += h;
    doc.moveTo(40, y).lineTo(40 + W, y).strokeColor("#e2e7ea").stroke();
    y += 3;
  }
  // Totals
  if (y > doc.page.height - 200) { doc.addPage(); y = 40; }
  y += 8;
  const totals: [string, string | null, boolean?][] = [["Subtotal", d.calc.subtotal]];
  if (d.calc.discountTotal && Number(d.calc.discountTotal)) totals.push(["Discounts included", d.calc.discountTotal]);
  if (d.calc.freight) totals.push(["Freight", d.calc.freight]);
  totals.push([`Tax (${q(d.rev.tax_rate)}%)`, d.calc.tax], [`Total ${d.calc.currency}`, d.calc.total, true]);
  for (const [k, v, strong] of totals) {
    text(k, 40 + W - 230, y, { font: strong ? "Bold" : "Regular", size: strong ? 11 : 9, width: 130, align: "right" });
    text(money(v), 40 + W - 100, y, { font: strong ? "Bold" : "Regular", size: strong ? 11 : 9, width: 100, align: "right" });
    y += strong ? 18 : 14;
  }
  if (!d.calc.ok) { text("Totals could not be calculated: " + d.calc.issues.filter((i) => i.blocking).map((i) => i.message).join(" "), 40, y, { size: 8, color: "#b91c1c", width: W }); y += 24; }

  // Terms
  y += 10;
  for (const [k, v] of [["Delivery", d.rev.delivery_terms], ["Payment", d.rev.payment_terms], ["Exclusions", d.rev.exclusions], ["Notes", d.rev.notes]] as const) {
    if (!v) continue;
    doc.font("Regular").fontSize(8.5);
    const h = doc.heightOfString(v, { width: W - 80 });
    if (y + h > doc.page.height - 60) { doc.addPage(); y = 40; }
    text(k, 40, y, { font: "Bold", size: 8.5, width: 75 });
    text(v, 120, y, { size: 8.5, width: W - 80 });
    y += h + 8;
  }
  if (d.preparedBy) text(`Prepared by ${d.preparedBy}`, 40, y + 10, { size: 8.5, color: gray });
  doc.end();
  await done;
  return { body: Buffer.concat(chunks), name: `${fileBase(d)}.pdf` };
}
