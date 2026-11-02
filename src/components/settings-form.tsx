"use client";
import { useActionState } from "react";
import { saveCompanyAction, type SettingsState } from "@/app/actions/settings";
import { Alert, Button, Field, Input, Textarea } from "./ui";

type C = { name: string; legal_name: string | null; address: string | null; phone: string | null; email: string | null; website: string | null;
  tax_number: string | null; default_currency: string; default_tax_rate: string; quote_prefix: string };

export function SettingsForm({ c, admin }: { c: C; admin: boolean }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(saveCompanyAction, undefined);
  return (
    <form action={action} className="max-w-3xl space-y-4 rounded-lg border border-line bg-white p-5">
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      {state?.message && <Alert tone="success">{state.message}</Alert>}
      <fieldset disabled={!admin || pending} className="space-y-4">
        <h2 className="font-semibold">Branding and contact details (shown on quotations)</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Company name *" htmlFor="name"><Input id="name" name="name" defaultValue={c.name} required /></Field>
          <Field label="Legal name" htmlFor="legal_name"><Input id="legal_name" name="legal_name" defaultValue={c.legal_name ?? ""} /></Field>
          <Field label="Phone" htmlFor="phone"><Input id="phone" name="phone" defaultValue={c.phone ?? ""} /></Field>
          <Field label="Email" htmlFor="email"><Input id="email" name="email" type="email" defaultValue={c.email ?? ""} /></Field>
          <Field label="Website" htmlFor="website"><Input id="website" name="website" defaultValue={c.website ?? ""} /></Field>
          <Field label="VAT / tax registration number" htmlFor="tax_number"><Input id="tax_number" name="tax_number" defaultValue={c.tax_number ?? ""} /></Field>
        </div>
        <Field label="Address" htmlFor="address"><Textarea id="address" name="address" rows={2} defaultValue={c.address ?? ""} /></Field>
        <h2 className="pt-2 font-semibold">Quotation defaults</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Default currency" htmlFor="default_currency"><Input id="default_currency" name="default_currency" defaultValue={c.default_currency} maxLength={3} /></Field>
          <Field label="Default tax rate %" htmlFor="default_tax_rate" hint="e.g. 15 for KSA VAT"><Input id="default_tax_rate" name="default_tax_rate" defaultValue={c.default_tax_rate} inputMode="decimal" /></Field>
          <Field label="Quotation number prefix" htmlFor="quote_prefix"><Input id="quote_prefix" name="quote_prefix" defaultValue={c.quote_prefix} /></Field>
        </div>
        {admin && <Button type="submit">{pending ? "Saving…" : "Save settings"}</Button>}
      </fieldset>
    </form>
  );
}
