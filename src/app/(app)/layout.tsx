import { requireCtx } from "@/lib/server/auth";
import { logoutAction, switchCompanyAction } from "@/app/actions/auth";
import { Nav } from "@/components/nav";
import { providerStatus } from "@/lib/ai";

// Signed-in pages depend on the user's session, so they are always rendered per request.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user, company, memberships } = await requireCtx();
  const ai = providerStatus({ demo: company.isDemo });
  const switcher = memberships.length > 1 && (
    <form action={switchCompanyAction} className="flex gap-1">
      <label htmlFor="companyId" className="sr-only">Workspace</label>
      <select id="companyId" name="companyId" defaultValue={company.companyId}
        className="w-full rounded-md border border-navy-700 bg-navy-800 px-2 py-1.5 text-xs text-white">
        {memberships.map((m) => <option key={m.companyId} value={m.companyId}>{m.companyName}</option>)}
      </select>
      <button type="submit" className="rounded-md bg-navy-700 px-2 text-xs text-white hover:bg-navy-800">Go</button>
    </form>
  );
  return (
    <div className="min-h-screen lg:flex">
      <aside className="no-print bg-navy-900 text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-60 lg:shrink-0 lg:flex-col">
        <div className="flex items-center justify-between gap-3 px-4 py-3 lg:block lg:py-5">
          <p className="text-lg font-semibold">Inquiry<span className="text-brand-500">Desk</span></p>
          <p className="truncate text-xs text-navy-200 lg:mt-1" dir="auto">{company.companyName}</p>
        </div>
        <div className="px-2 pb-2 lg:hidden"><Nav horizontal /></div>
        <div className="hidden flex-1 px-2 lg:block"><Nav /></div>
        <div className="hidden space-y-3 border-t border-navy-800 p-4 text-xs lg:block">
          {switcher}
          <p className="text-navy-200" title={ai.problem}>{ai.label}</p>
          <p className="truncate text-navy-200">{user.email} · {company.role === "admin" ? "Admin" : "Salesperson"}</p>
          <form action={logoutAction}><button className="text-navy-100 underline hover:text-white" type="submit">Sign out</button></form>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {company.isDemo && (
          <div className="no-print border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900" role="status">
            <strong>Demo workspace.</strong> Fictional products and customers. Processing here uses the rule-based reader, not live AI.
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-b border-line bg-white px-4 py-2 text-xs text-muted lg:hidden no-print">
          <span className="truncate">{user.email} · {ai.label}</span>
          <div className="flex items-center gap-2">{switcher}<form action={logoutAction}><button className="underline" type="submit">Sign out</button></form></div>
        </div>
        <main className="mx-auto max-w-7xl px-4 py-6 md:px-6">{children}</main>
      </div>
    </div>
  );
}
