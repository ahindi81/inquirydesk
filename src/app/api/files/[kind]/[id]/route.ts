import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/server/auth";
import { asUser } from "@/lib/server/db";
import { getObject, signedUrl } from "@/lib/server/storage";

// Authorized file download. The row is looked up as the signed-in user, so
// row-level security decides access; files are never publicly addressable.
export async function GET(_req: Request, { params }: RouteContext<"/api/files/[kind]/[id]">) {
  const { kind, id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("Sign in required", { status: 401 });
  if (!/^[0-9a-f-]{36}$/.test(id) || !["document", "datasheet"].includes(kind)) return new NextResponse("Not found", { status: 404 });
  const row = await asUser(user.id, async (tx) => {
    if (kind === "document") {
      const [d] = await tx<{ path: string; name: string; mime: string }[]>`select storage_path path, file_name name, mime_type mime from inquiry_documents where id = ${id}`;
      return d;
    }
    const [p] = await tx<{ path: string | null; name: string }[]>`select datasheet_path path, sku || '-datasheet.pdf' name from catalogue_products where id = ${id}`;
    return p?.path ? { path: p.path, name: p.name, mime: "application/pdf" } : undefined;
  });
  if (!row) return new NextResponse("Not found", { status: 404 });
  const url = await signedUrl(row.path, row.name);
  if (url) return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store" } });
  const body = await getObject(row.path);
  return new NextResponse(new Uint8Array(body), { headers: {
    "Content-Type": row.mime, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
}
