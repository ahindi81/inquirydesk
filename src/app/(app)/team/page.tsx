import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { updateMemberAction } from "@/app/actions/settings";
import { Alert, Badge, PageHeader, Table, fmtDate, td, th } from "@/components/ui";

export const metadata = { title: "Team" };
export default async function TeamPage() {
  const { user, company } = await requireCtx();
  const members = await asUser(user.id, (tx) => tx<{ user_id: string; full_name: string | null; role: string; created_at: Date }[]>`
    select user_id, full_name, role, created_at from company_members where company_id = ${company.companyId} order by role, full_name`);
  const admin = company.role === "admin";
  return (
    <div className="space-y-5">
      <PageHeader title="Team" subtitle="Admins manage the catalogue, prices, company settings and team. Salespeople work on inquiries and quotations." />
      <Alert tone="info">Adding colleagues by email invitation is not built yet — it is the next team feature. Until then, each person who signs up gets their own separate workspace.</Alert>
      <Table>
        <thead><tr><th className={th}>Name</th><th className={th}>Role</th><th className={th}>Member since</th>{admin && <th className={th}>Actions</th>}</tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user_id}>
              <td className={td}>
                {admin ? (
                  <form action={updateMemberAction} className="flex gap-2">
                    <input type="hidden" name="userId" value={m.user_id} /><input type="hidden" name="op" value="name" />
                    <label className="sr-only" htmlFor={`n-${m.user_id}`}>Name</label>
                    <input id={`n-${m.user_id}`} name="full_name" defaultValue={m.full_name ?? ""} placeholder="Name" className="rounded-md border border-line px-2 py-1 text-sm" />
                    <button className="text-xs underline" type="submit">Save</button>
                  </form>
                ) : (m.full_name ?? "—")}
                {m.user_id === user.id && <span className="ms-1 text-xs text-muted">(you)</span>}
              </td>
              <td className={td}><Badge tone={m.role === "admin" ? "navy" : "gray"}>{m.role === "admin" ? "Admin" : "Salesperson"}</Badge></td>
              <td className={`${td} text-muted`}>{fmtDate(m.created_at)}</td>
              {admin && (
                <td className={td}>
                  <form action={updateMemberAction} className="flex flex-wrap gap-2 text-xs">
                    <input type="hidden" name="userId" value={m.user_id} />
                    <button name="op" value={m.role === "admin" ? "salesperson" : "admin"} className="underline" type="submit">Make {m.role === "admin" ? "salesperson" : "admin"}</button>
                    {m.user_id !== user.id && <button name="op" value="remove" className="text-red-700 underline" type="submit">Remove</button>}
                  </form>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-xs text-muted">A workspace always keeps at least one admin.</p>
    </div>
  );
}
