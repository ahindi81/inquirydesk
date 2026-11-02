import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { loadRevision } from "@/lib/server/quotation-data";
import { toCsv, toPdf, toXlsx, type ExportData } from "@/lib/server/export";

const TYPES = { pdf: "application/pdf", csv: "text/csv; charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

export async function GET(req: Request, { params }: RouteContext<"/api/quotations/[id]/export">) {
  const { id } = await params;
  const format = new URL(req.url).searchParams.get("format") as keyof typeof TYPES;
  if (!(format in TYPES) || !/^[0-9a-f-]{36}$/.test(id)) return new NextResponse("Not found", { status: 404 });
  const user = await getSessionUser();
  if (!user) return new NextResponse("Sign in required", { status: 401 });
  const data = await asUser(user.id, async (tx): Promise<ExportData | null> => {
    const [r] = await tx<{ company_id: string }[]>`select company_id from quotation_revisions where id = ${id}`;
    if (!r) return null; // not visible to this user (RLS) or does not exist
    const loaded = await loadRevision(tx, r.company_id, id);
    if (!loaded) return null;
    const [company] = await tx<ExportData["company"][]>`
      select name, legal_name, address, phone, email, website, tax_number, is_demo from companies where id = ${r.company_id}`;
    const [inq] = await tx<{ name: string; project: string | null; reference: string | null; owner: string | null }[]>`
      select i.customer_name name, i.project_name project, i.reference_number reference, m.full_name owner
        from inquiries i left join company_members m on m.company_id = i.company_id and m.user_id = i.owner_id where i.id = ${loaded.rev.inquiry_id}`;
    // Approved revisions export their frozen totals; drafts are calculated now.
    const calc = loaded.rev.status !== "draft" && loaded.rev.totals ? (loaded.rev.totals as ExportData["calc"]) : loaded.calc;
    return { company, customer: inq, rev: loaded.rev, lines: loaded.lines, calc, preparedBy: inq.owner };
  });
  if (!data) return new NextResponse("Not found", { status: 404 });
  const out = format === "pdf" ? await toPdf(data) : format === "xlsx" ? await toXlsx(data) : toCsv(data);
  return new NextResponse(new Uint8Array(out.body), { headers: {
    "Content-Type": TYPES[format], "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(out.name)}`, "Cache-Control": "private, no-store",
  } });
}
