"use client";
import { useActionState } from "react";
import { saveProductAction, type ProductFormState } from "@/app/actions/catalogue";
import { Alert, Button, ButtonLink, Field, Input, Select, Textarea } from "./ui";

export type ProductInit = { id?: string; sku?: string; name?: string; brand?: string | null; category?: string | null; description?: string | null;
  specifications?: string; unit?: string; variants?: string; unit_price?: string | null; currency?: string | null; lead_time_days?: number | null;
  active?: boolean; hasDatasheet?: boolean };

const CURRENCIES = ["SAR", "AED", "USD", "EUR", "GBP", "KWD", "QAR", "BHD", "OMR", "EGP"];

export function ProductForm({ p, defaultCurrency }: { p: ProductInit; defaultCurrency: string }) {
  const [state, action, pending] = useActionState<ProductFormState, FormData>(saveProductAction, undefined);
  return (
    <form action={action} className="max-w-3xl space-y-5 rounded-lg border border-line bg-white p-5">
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      {p.id && <input type="hidden" name="id" value={p.id} />}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="SKU / product code *" htmlFor="sku"><Input id="sku" name="sku" defaultValue={p.sku} required /></Field>
        <Field label="Product name *" htmlFor="name"><Input id="name" name="name" defaultValue={p.name} required /></Field>
        <Field label="Brand" htmlFor="brand"><Input id="brand" name="brand" defaultValue={p.brand ?? ""} /></Field>
        <Field label="Category" htmlFor="category"><Input id="category" name="category" defaultValue={p.category ?? ""} /></Field>
      </div>
      <Field label="Description" htmlFor="description"><Textarea id="description" name="description" rows={2} defaultValue={p.description ?? ""} /></Field>
      <Field label="Technical specifications" htmlFor="specifications" hint='One per line or separated by ";" — e.g. "size: 600x600 mm; slip rating: R10".'>
        <Textarea id="specifications" name="specifications" rows={3} defaultValue={p.specifications ?? ""} />
      </Field>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Unit of measure *" htmlFor="unit" hint="e.g. m2, pcs, L, bag"><Input id="unit" name="unit" defaultValue={p.unit} required /></Field>
        <Field label="Variants / finishes" htmlFor="variants" hint="Comma-separated"><Input id="variants" name="variants" defaultValue={p.variants ?? ""} /></Field>
        <Field label="Lead time (days)" htmlFor="lead_time_days" hint="Leave blank if not confirmed"><Input id="lead_time_days" name="lead_time_days" type="number" min={0} step={1} defaultValue={p.lead_time_days ?? ""} /></Field>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Approved unit selling price" htmlFor="unit_price" hint="Leave blank if not approved. Blank is never treated as zero.">
          <Input id="unit_price" name="unit_price" inputMode="decimal" defaultValue={p.unit_price ?? ""} />
        </Field>
        <Field label="Currency" htmlFor="currency">
          <Select id="currency" name="currency" defaultValue={p.currency ?? defaultCurrency}>
            {[...new Set([p.currency ?? defaultCurrency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Status" htmlFor="active">
          <Select id="active" name="active" defaultValue={p.active === false ? "off" : "on"}>
            <option value="on">Active — can be suggested</option><option value="off">Inactive — hidden from matching</option>
          </Select>
        </Field>
      </div>
      <Field label={p.hasDatasheet ? "Replace datasheet (PDF)" : "Datasheet (PDF)"} htmlFor="datasheet">
        <input id="datasheet" name="datasheet" type="file" accept="application/pdf,.pdf" className="text-sm" />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save product"}</Button>
        <ButtonLink variant="secondary" href="/catalogue">Cancel</ButtonLink>
      </div>
    </form>
  );
}
