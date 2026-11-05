"use client";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInvitationAction, renewInvitationAction, revokeInvitationAction, type InviteState } from "@/app/actions/team";
import { Alert, Badge, Button, Card, Field, Input, Select, Table, fmtDate, td, th } from "./ui";

export type PendingInvite = { id: string; email: string; role: string; created_at: string; expires_at: string; expired: boolean };

function LinkBox({ link, email, companyName }: { link: string; email: string; companyName: string }) {
  const [copied, setCopied] = useState(false);
  const subject = `Join ${companyName} on InquiryDesk`;
  const body = `Hello,\n\nYou've been invited to join ${companyName} on InquiryDesk.\n\nOpen this link and sign in or create an account with ${email}:\n${link}\n\nThe link works once and expires in 7 days.`;
  return (
    <div className="space-y-2 rounded-md border border-brand-100 bg-brand-50 p-3">
      <p className="text-sm font-medium">Invitation link for {email}</p>
      <p className="text-xs text-muted">Send this link to your colleague yourself — InquiryDesk does not send it. It is shown only now; use “New link” later if needed.</p>
      <div className="flex flex-wrap gap-2">
        <input readOnly value={link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1.5 font-mono text-xs" />
        <Button type="button" variant="secondary" onClick={async () => {
          try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); }
        }}>{copied ? "Copied" : "Copy link"}</Button>
        <a className="inline-flex items-center rounded-md border border-line bg-white px-3 py-2 text-sm hover:bg-canvas"
          href={`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>Open in email</a>
        <a className="inline-flex items-center rounded-md border border-line bg-white px-3 py-2 text-sm hover:bg-canvas" target="_blank" rel="noreferrer"
          href={`https://wa.me/?text=${encodeURIComponent(body)}`}>Share on WhatsApp</a>
      </div>
    </div>
  );
}

export function InviteForm({ companyName }: { companyName: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(createInvitationAction, undefined);
  return (
    <Card title="Invite a colleague">
      <form action={action} className="space-y-3">
        {state?.error && <Alert tone="error">{state.error}</Alert>}
        <div className="grid gap-3 md:grid-cols-[1fr_200px_auto] md:items-end">
          <Field label="Colleague's work email" htmlFor="invite-email"><Input id="invite-email" name="email" type="email" required autoComplete="off" /></Field>
          <Field label="Role" htmlFor="invite-role">
            <Select id="invite-role" name="role" defaultValue="salesperson">
              <option value="salesperson">Salesperson</option><option value="admin">Admin</option>
            </Select>
          </Field>
          <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create invitation link"}</Button>
        </div>
        <p className="text-xs text-muted">They must sign in or create an account with this exact email. Links work once and expire after 7 days.</p>
        {state?.link && state.email && <LinkBox link={state.link} email={state.email} companyName={companyName} />}
      </form>
    </Card>
  );
}

export function PendingInvites({ invites, companyName }: { invites: PendingInvite[]; companyName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<InviteState>(undefined);
  if (invites.length === 0) return null;
  const run = (fn: () => Promise<InviteState>) => start(async () => { setResult(await fn()); router.refresh(); });
  return (
    <Card title="Open invitations">
      <div className="space-y-3">
        {result?.error && <Alert tone="error">{result.error}</Alert>}
        {result?.message && <Alert tone="success">{result.message}</Alert>}
        {result?.link && result.email && <LinkBox link={result.link} email={result.email} companyName={companyName} />}
        <Table>
          <thead><tr><th className={th}>Email</th><th className={th}>Role</th><th className={th}>Sent</th><th className={th}>Status</th><th className={th}></th></tr></thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.id}>
                <td className={td}>{i.email}</td>
                <td className={td}>{i.role === "admin" ? "Admin" : "Salesperson"}</td>
                <td className={`${td} text-muted`}>{fmtDate(i.created_at)}</td>
                <td className={td}>{i.expired ? <Badge tone="amber">Expired</Badge> : <Badge tone="blue">Waiting · until {fmtDate(i.expires_at)}</Badge>}</td>
                <td className={`${td} whitespace-nowrap text-end`}>
                  <button className="text-xs text-brand-700 underline" disabled={pending} onClick={() => run(() => renewInvitationAction(i.id))}>New link</button>
                  <button className="ms-3 text-xs text-red-700 underline" disabled={pending}
                    onClick={() => { if (confirm(`Cancel the invitation for ${i.email}?`)) run(() => revokeInvitationAction(i.id)); }}>Cancel</button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}
