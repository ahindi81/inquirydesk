"use client";
import { useState, useTransition } from "react";
import { commitImportAction, previewImportAction, type ImportPreview, type ImportResult } from "@/app/actions/catalogue";
import { PRODUCT_FIELDS, type Mapping, type ProductFieldKey } from "@/lib/catalogue-import";
import { Alert, Button, ButtonLink, Card, Table, td, th } from "./ui";

export function CatalogueImport() {
  const [preview, setPreview] = useState<Extract<ImportPreview, { ok: true }> | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pending, start] = useTransition();

  const onFile = (fd: FormData) => start(async () => {
    setError(null); setResult(null);
    const r = await previewImportAction(fd);
    if (!r.ok) { setError(r.error); setPreview(null); return; }
    setPreview(r); setMapping(r.mapping);
  });
  const commit = (mode: "all_or_nothing" | "valid_only") => start(async () => {
    if (!preview) return;
    setResult(await commitImportAction(preview.rows, mapping, mode));
  });
  const setField = (k: ProductFieldKey, v: string) => setMapping((m) => {
    const n = { ...m }; if (v === "") delete n[k]; else n[k] = Number(v); return n;
  });

  return (
    <div className="space-y-5">
      <Card title="1. Choose a file">
        <form action={onFile} className="flex flex-wrap items-center gap-3">
          <label htmlFor="file" className="sr-only">Catalogue file</label>
          <input id="file" name="file" type="file" accept=".csv,.xlsx" required className="text-sm" />
          <Button type="submit" disabled={pending}>{pending && !preview ? "Reading…" : "Read file"}</Button>
          <p className="w-full text-xs text-muted">CSV or Excel (.xlsx), first row = column headings, up to 5,000 products. Existing products with the same SKU are updated.</p>
        </form>
        {error && <div className="mt-3"><Alert tone="error">{error}</Alert></div>}
      </Card>

      {preview && (
        <Card title={`2. Match columns — ${preview.fileName}${preview.sheet ? ` (sheet "${preview.sheet}")` : ""}, ${preview.rows.length} rows`}>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {PRODUCT_FIELDS.map((f) => (
              <div key={f.key}>
                <label htmlFor={`map-${f.key}`} className="block text-sm font-medium">{f.label}{"required" in f && f.required ? " *" : ""}</label>
                <select id={`map-${f.key}`} value={mapping[f.key] ?? ""} onChange={(e) => setField(f.key, e.target.value)}
                  className="mt-1 block w-full rounded-md border border-line bg-white px-2 py-1.5 text-sm">
                  <option value="">— not in file —</option>
                  {preview.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">Rows without a price are imported with no price (never zero). If a price has no currency, your company&apos;s default currency is used.</p>
          <h3 className="mt-5 mb-2 text-sm font-semibold">Preview (first 5 rows)</h3>
          <Table>
            <thead><tr>{PRODUCT_FIELDS.filter((f) => mapping[f.key] !== undefined).map((f) => <th key={f.key} className={th}>{f.label}</th>)}</tr></thead>
            <tbody>
              {preview.rows.slice(0, 5).map((r, i) => (
                <tr key={i}>{PRODUCT_FIELDS.filter((f) => mapping[f.key] !== undefined).map((f) => <td key={f.key} className={td} dir="auto">{r[mapping[f.key]!]}</td>)}</tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => commit("all_or_nothing")} disabled={pending}>{pending ? "Importing…" : "Validate and import"}</Button>
          </div>
        </Card>
      )}

      {result && (
        <Card title="3. Result">
          {result.ok ? (
            <Alert tone="success" title="Import complete">
              {result.inserted} product(s) added, {result.updated} updated.{result.errors.length ? ` ${result.errors.length} row(s) were skipped (listed below).` : ""}
            </Alert>
          ) : <Alert tone="error">{result.error}</Alert>}
          {"errors" in result && result.errors && result.errors.length > 0 && (
            <>
              <ul className="mt-3 max-h-64 overflow-auto rounded-md border border-line text-sm">
                {result.errors.map((e) => <li key={e.row} className="border-b border-line px-3 py-1.5 last:border-0"><strong>Row {e.row}:</strong> {e.message}</li>)}
              </ul>
              {!result.ok && <div className="mt-3"><Button variant="secondary" onClick={() => commit("valid_only")} disabled={pending}>Import only the valid rows</Button></div>}
            </>
          )}
          {result.ok && <div className="mt-3"><ButtonLink href="/catalogue">View catalogue</ButtonLink></div>}
        </Card>
      )}
    </div>
  );
}
