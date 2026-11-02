"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/server/auth";
import { asUser, dbErrorMessage } from "@/lib/server/db";
import { putObject } from "@/lib/server/storage";
import { guessMapping, parseSpecs, validateRows, type Mapping, type CleanProduct, type RowError } from "@/lib/catalogue-import";
import { Dec } from "@/lib/quote/decimal";

export type ProductFormState = { error?: string } | undefined;

function str(fd: FormData, k: string) { const v = String(fd.get(k) ?? "").trim(); return v || null; }

export async function saveProductAction(_: ProductFormState, fd: FormData): Promise<ProductFormState> {
  const ctx = await requireCtx({ admin: true });
  const id = str(fd, "id");
  const sku = str(fd, "sku"), name = str(fd, "name"), unit = str(fd, "unit");
  if (!sku || !name || !unit) return { error: "SKU, product name and unit are required." };
  let price: string | null = null;
  const rawPrice = str(fd, "unit_price");
  if (rawPrice) {
    try { const d = Dec.from(rawPrice.replace(/,/g, "")); if (d.isNeg()) return { error: "Price cannot be negative." }; price = d.toString(); }
    catch { return { error: `Price "${rawPrice}" is not a valid number.` }; }
  }
  const currency = str(fd, "currency")?.toUpperCase() ?? null;
  if (price !== null && !currency) return { error: "Choose the price currency." };
  if (currency && !/^[A-Z]{3}$/.test(currency)) return { error: "Currency must be a 3-letter code such as SAR." };
  const leadRaw = str(fd, "lead_time_days");
  const lead = leadRaw === null ? null : Number(leadRaw);
  if (lead !== null && (!Number.isInteger(lead) || lead < 0)) return { error: "Lead time must be a whole number of days." };
  const specs = parseSpecs(str(fd, "specifications") ?? "");
  const variants = (str(fd, "variants") ?? "").split(/[,;]/).map((v) => v.trim()).filter(Boolean);
  const datasheet = fd.get("datasheet");
  let newId: string;
  try {
    newId = await asUser(ctx.user.id, async (tx) => {
      const vals = { sku, name, brand: str(fd, "brand"), category: str(fd, "category"), description: str(fd, "description"),
        unit, unit_price: price, currency, lead_time_days: lead, active: fd.get("active") !== "off" };
      if (id) {
        const [r] = await tx<{ id: string }[]>`update catalogue_products set ${tx(vals)}, specifications = ${tx.json(specs)}, variants = ${variants},
          updated_by = ${ctx.user.id}, updated_at = now() where id = ${id} and company_id = ${ctx.company.companyId} returning id`;
        if (!r) throw new Error("not found");
        return r.id;
      }
      const [r] = await tx<{ id: string }[]>`insert into catalogue_products ${tx({ ...vals, company_id: ctx.company.companyId, created_by: ctx.user.id })}
        returning id`;
      await tx`update catalogue_products set specifications = ${tx.json(specs)}, variants = ${variants} where id = ${r.id}`;
      return r.id;
    });
    if (datasheet instanceof File && datasheet.size > 0) {
      if (datasheet.size > 25 * 1024 * 1024) return { error: "Datasheet is larger than 25 MB." };
      const buf = Buffer.from(await datasheet.arrayBuffer());
      if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return { error: "Datasheet must be a PDF file." };
      const key = `${ctx.company.companyId}/catalogue/${newId}.pdf`;
      await putObject(key, buf, "application/pdf");
      await asUser(ctx.user.id, (tx) => tx`update catalogue_products set datasheet_path = ${key} where id = ${newId}`);
    }
  } catch (e) {
    const msg = dbErrorMessage(e);
    return { error: /already exists/.test(msg) ? `A product with SKU "${sku}" already exists.` : msg };
  }
  revalidatePath("/catalogue");
  redirect("/catalogue?saved=1");
}

export async function deleteProductAction(fd: FormData) {
  const ctx = await requireCtx({ admin: true });
  const id = String(fd.get("id"));
  try {
    await asUser(ctx.user.id, (tx) => tx`delete from catalogue_products where id = ${id} and company_id = ${ctx.company.companyId}`);
  } catch {
    // Referenced by quotations/matches: keep history, hide from matching instead.
    await asUser(ctx.user.id, (tx) => tx`update catalogue_products set active = false, updated_by = ${ctx.user.id} where id = ${id}`);
    redirect("/catalogue?deactivated=1");
  }
  redirect("/catalogue?deleted=1");
}

// ---------------------------------------------------------------- import

export type ImportPreview = { ok: true; fileName: string; headers: string[]; rows: string[][]; mapping: Mapping; sheet?: string }
  | { ok: false; error: string };

export async function previewImportAction(fd: FormData): Promise<ImportPreview> {
  await requireCtx({ admin: true });
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a CSV or Excel (.xlsx) file." };
  if (file.size > 10 * 1024 * 1024) return { ok: false, error: "Catalogue files are limited to 10 MB." };
  const buf = Buffer.from(await file.arrayBuffer());
  const ext = file.name.toLowerCase().split(".").pop();
  let table: string[][] = [];
  let sheet: string | undefined;
  try {
    if (ext === "csv" || ext === "txt") {
      const Papa = (await import("papaparse")).default;
      let text = buf.toString("utf8"); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      table = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
    } else if (ext === "xlsx") {
      if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return { ok: false, error: "This does not look like a valid .xlsx file." };
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
      if (!ws) return { ok: false, error: "The workbook has no data." };
      sheet = ws.name;
      ws.eachRow({ includeEmpty: false }, (row) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (c, i) => {
          const v = c.value as unknown;
          cells[i - 1] = v === null || v === undefined ? "" : typeof v === "object"
            ? String((v as { result?: unknown; text?: unknown }).result ?? (v as { text?: unknown }).text ?? "") : String(v);
        });
        table.push(Array.from(cells, (c) => c ?? ""));
      });
    } else return { ok: false, error: "Use a .csv or .xlsx file. Old .xls files must be saved as .xlsx first." };
  } catch {
    return { ok: false, error: "The file could not be read. Check it opens in Excel and is not password-protected." };
  }
  if (table.length < 2) return { ok: false, error: "The file needs a header row and at least one product row." };
  if (table.length > 5001) return { ok: false, error: "Import up to 5,000 products at a time." };
  const headers = table[0].map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`);
  return { ok: true, fileName: file.name, headers, rows: table.slice(1), mapping: guessMapping(headers), sheet };
}

export type ImportResult = { ok: true; inserted: number; updated: number; errors: RowError[] } | { ok: false; error: string; errors?: RowError[] };

export async function commitImportAction(rows: string[][], mapping: Mapping, mode: "all_or_nothing" | "valid_only"): Promise<ImportResult> {
  const ctx = await requireCtx({ admin: true });
  if (!Array.isArray(rows) || rows.length > 5000) return { ok: false, error: "Invalid import data." };
  const [{ default_currency }] = await asUser(ctx.user.id, (tx) =>
    tx<{ default_currency: string }[]>`select default_currency from companies where id = ${ctx.company.companyId}`);
  const { products, errors } = validateRows(rows.map((r) => (Array.isArray(r) ? r.map(String) : [])), mapping, default_currency);
  if (errors.some((e) => e.row === 0)) return { ok: false, error: errors[0].message };
  if (errors.length && mode === "all_or_nothing")
    return { ok: false, error: `${errors.length} row(s) have problems. Fix them, or choose to import only the valid rows.`, errors };
  if (products.length === 0) return { ok: false, error: "No valid product rows to import.", errors };
  try {
    const res = await asUser(ctx.user.id, async (tx) => {
      let inserted = 0, updated = 0;
      for (const p of products as CleanProduct[]) {
        const [r] = await tx<{ inserted: boolean }[]>`
          insert into catalogue_products (company_id, sku, name, brand, category, description, specifications, unit, variants,
            unit_price, currency, lead_time_days, created_by, updated_by)
          values (${ctx.company.companyId}, ${p.sku}, ${p.name}, ${p.brand}, ${p.category}, ${p.description}, ${tx.json(p.specifications)},
            ${p.unit}, ${p.variants}, ${p.unit_price}, ${p.currency}, ${p.lead_time_days}, ${ctx.user.id}, ${ctx.user.id})
          on conflict (company_id, sku) do update set name = excluded.name, brand = excluded.brand, category = excluded.category,
            description = excluded.description, specifications = excluded.specifications, unit = excluded.unit, variants = excluded.variants,
            unit_price = excluded.unit_price, currency = excluded.currency, lead_time_days = excluded.lead_time_days,
            updated_by = excluded.updated_by, updated_at = now(), active = true
          returning (xmax = 0) as inserted`;
        if (r.inserted) inserted++; else updated++;
      }
      return { inserted, updated };
    });
    revalidatePath("/catalogue");
    return { ok: true, ...res, errors };
  } catch (e) {
    return { ok: false, error: dbErrorMessage(e) };
  }
}
