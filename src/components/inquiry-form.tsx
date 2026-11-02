"use client";
import { useActionState } from "react";
import { createInquiryAction, type InquiryFormState } from "@/app/actions/inquiry";
import { Alert, Button, ButtonLink, Field, Input, Select, Textarea } from "./ui";

export function NewInquiryForm({ members, me }: { members: { id: string; name: string }[]; me: string }) {
  const [state, action, pending] = useActionState<InquiryFormState, FormData>(createInquiryAction, undefined);
  return (
    <form action={action} className="max-w-3xl space-y-5 rounded-lg border border-line bg-white p-5">
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Customer *" htmlFor="customer_name"><Input id="customer_name" name="customer_name" required /></Field>
        <Field label="Project" htmlFor="project_name"><Input id="project_name" name="project_name" /></Field>
        <Field label="Customer reference / RFQ number" htmlFor="reference_number"><Input id="reference_number" name="reference_number" /></Field>
        <Field label="Owner" htmlFor="owner_id">
          <Select id="owner_id" name="owner_id" defaultValue={me}>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
        </Field>
        <Field label="Quotation deadline" htmlFor="quotation_deadline" hint="Leave blank if unknown — it can be read from the documents.">
          <Input id="quotation_deadline" name="quotation_deadline" type="date" />
        </Field>
      </div>
      <Field label="Customer email or inquiry text (optional)" htmlFor="pasted_text" hint="Paste the email body here. English and Arabic are both supported. You can upload files on the next step.">
        <Textarea id="pasted_text" name="pasted_text" rows={8} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create and add documents"}</Button>
        <ButtonLink variant="secondary" href="/inquiries">Cancel</ButtonLink>
      </div>
    </form>
  );
}
