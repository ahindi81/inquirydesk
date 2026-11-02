import { requireCtx } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { PageHeader } from "@/components/ui";
import { NewInquiryForm } from "@/components/inquiry-form";

export const metadata = { title: "New inquiry" };
export default async function NewInquiry() {
  const { user, company } = await requireCtx();
  const members = await asUser(user.id, (tx) => tx<{ id: string; name: string }[]>`
    select user_id as id, coalesce(full_name, 'Team member') as name from company_members where company_id = ${company.companyId} order by full_name`);
  return (<div><PageHeader title="New inquiry" /><NewInquiryForm members={members.map((m) => (m.id === user.id ? { ...m, name: `${m.name} (me)` } : m))} me={user.id} /></div>);
}
