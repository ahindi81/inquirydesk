import "server-only";
import { execFile as _execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(_execFile);

/** A piece of document text with a human-readable location, e.g. "page 3" or "BOQ!R14". */
export type Segment = { ref: string; text: string; ocr?: boolean };

export type FileKind = "pdf" | "docx" | "xlsx" | "csv" | "text" | "image";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_INQUIRY = 20;

const KINDS: Record<string, { kind: FileKind; mime: string }> = {
  pdf: { kind: "pdf", mime: "application/pdf" },
  docx: { kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { kind: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  csv: { kind: "csv", mime: "text/csv" },
  txt: { kind: "text", mime: "text/plain" },
  eml: { kind: "text", mime: "text/plain" },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  webp: { kind: "image", mime: "image/webp" },
  tif: { kind: "image", mime: "image/tiff" },
  tiff: { kind: "image", mime: "image/tiff" },
};

export class FileRejected extends Error {}

/** Validate name, size and actual content signature (not just the extension). */
export function identifyFile(name: string, data: Buffer): { kind: FileKind; mime: string } {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "doc" || ext === "xls")
    throw new FileRejected(`"${name}" is an old Office format (.${ext}). Save it as .${ext}x and upload again.`);
  const k = KINDS[ext];
  if (!k) throw new FileRejected(`"${name}" is not a supported file type. Use PDF, Word (.docx), Excel (.xlsx), CSV, text or image files.`);
  if (data.length === 0) throw new FileRejected(`"${name}" is empty.`);
  if (data.length > MAX_FILE_BYTES) throw new FileRejected(`"${name}" is ${(data.length / 1048576).toFixed(1)} MB. The limit is 25 MB per file.`);
  const head = data.subarray(0, 8);
  const sig = {
    pdf: head.subarray(0, 5).toString("latin1") === "%PDF-",
    zip: head[0] === 0x50 && head[1] === 0x4b,
    png: head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    jpg: head[0] === 0xff && head[1] === 0xd8,
    webp: data.subarray(8, 12).toString("latin1") === "WEBP",
    tif: head.subarray(0, 2).toString("latin1") === "II" || head.subarray(0, 2).toString("latin1") === "MM",
  };
  const ok =
    k.kind === "pdf" ? sig.pdf :
    k.kind === "docx" || k.kind === "xlsx" ? sig.zip :
    k.kind === "image" ? (ext === "png" ? sig.png : ext === "webp" ? sig.webp : ext.startsWith("tif") ? sig.tif : sig.jpg) :
    !data.subarray(0, 4096).includes(0); // text: no NUL bytes
  if (!ok) throw new FileRejected(`"${name}" does not look like a valid .${ext} file. It may be damaged or misnamed.`);
  return k;
}

export type ReadResult = { segments: Segment[]; ocrUsed: boolean; warnings: string[]; needsVisionOcr: boolean };

/** Extract text segments. Throws FileRejected with a readable reason when unreadable. */
export async function readFileSegments(name: string, kind: FileKind, data: Buffer): Promise<ReadResult> {
  const warnings: string[] = [];
  switch (kind) {
    case "text": return { segments: textSegments(decodeText(data), "line"), ocrUsed: false, warnings, needsVisionOcr: false };
    case "csv": return { segments: await csvSegments(decodeText(data)), ocrUsed: false, warnings, needsVisionOcr: false };
    case "xlsx": return { segments: await xlsxSegments(data, name), ocrUsed: false, warnings, needsVisionOcr: false };
    case "docx": return { segments: await docxSegments(data, name), ocrUsed: false, warnings, needsVisionOcr: false };
    case "pdf": return pdfSegments(data, name);
    case "image": {
      const ocr = await ocrImage(data, name);
      if (ocr === null) return { segments: [], ocrUsed: false, warnings: ["OCR is not available on this server."], needsVisionOcr: true };
      if (!ocr.trim()) throw new FileRejected(`No readable text was found in "${name}".`);
      return { segments: textSegments(ocr, "image line").map((s) => ({ ...s, ocr: true })), ocrUsed: true, warnings, needsVisionOcr: false };
    }
  }
}

function decodeText(data: Buffer) {
  // UTF-8 with BOM handling; Windows Arabic exports are often UTF-16LE.
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString("utf16le");
  let s = data.toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

export function textSegments(text: string, label: string): Segment[] {
  return text.replace(/\r\n?/g, "\n").split("\n")
    .map((t, i) => ({ ref: `${label} ${i + 1}`, text: t.trim() }))
    .filter((s) => s.text.length > 0);
}

async function csvSegments(text: string): Promise<Segment[]> {
  const Papa = (await import("papaparse")).default;
  const res = Papa.parse<string[]>(text, { skipEmptyLines: true });
  if (res.errors.length && res.data.length === 0) throw new FileRejected("The CSV file could not be read.");
  return res.data
    .map((row, i) => ({ ref: `row ${i + 1}`, text: row.map((c) => String(c ?? "").trim()).filter(Boolean).join(" | ") }))
    .filter((s) => s.text);
}

async function xlsxSegments(data: Buffer, name: string): Promise<Segment[]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(data as unknown as ArrayBuffer); }
  catch { throw new FileRejected(`"${name}" could not be opened as an Excel workbook. It may be password-protected or damaged.`); }
  const out: Segment[] = [];
  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const v = cellText(cell.value);
        cells[c - 1] = v;
      });
      const text = cells.map((c) => (c ?? "").trim()).join(" | ").replace(/(\s\|\s)+$/g, "").replace(/^(\s?\|\s)+/, "");
      if (text.replace(/[|\s]/g, "")) out.push({ ref: `${ws.name}!R${r}`, text });
    });
  });
  if (out.length === 0) throw new FileRejected(`"${name}" has no data in any sheet.`);
  return out;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return cellText(o.result);                 // formula
    if ("richText" in o) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("text" in o) return String(o.text);                         // hyperlink
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ("error" in o) return "";
  }
  return String(v);
}

async function docxSegments(data: Buffer, name: string): Promise<Segment[]> {
  const mammoth = await import("mammoth");
  let text: string;
  try { text = (await mammoth.extractRawText({ buffer: data })).value; }
  catch { throw new FileRejected(`"${name}" could not be opened as a Word document.`); }
  const segs = text.split(/\n+/).map((t) => t.trim()).filter(Boolean).map((t, i) => ({ ref: `paragraph ${i + 1}`, text: t }));
  if (segs.length === 0) throw new FileRejected(`"${name}" contains no text.`);
  return segs;
}

async function pdfSegments(data: Buffer, name: string): Promise<ReadResult> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    pages = (await extractText(pdf, { mergePages: false })).text as string[];
  } catch (e) {
    const msg = String((e as Error).message ?? "");
    if (/password/i.test(msg)) throw new FileRejected(`"${name}" is password-protected. Remove the password and upload again.`);
    throw new FileRejected(`"${name}" could not be read as a PDF. It may be damaged.`);
  }
  const segments: Segment[] = [];
  const emptyPages: number[] = [];
  pages.forEach((p, i) => {
    const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.join("").length < 15) emptyPages.push(i + 1);
    lines.forEach((l, j) => segments.push({ ref: `page ${i + 1}, line ${j + 1}`, text: l }));
  });
  const warnings: string[] = [];
  let ocrUsed = false;
  if (emptyPages.length) {
    const ocr = await ocrPdfPages(data, emptyPages);
    if (ocr === null) {
      return { segments, ocrUsed, warnings: [`Page(s) ${emptyPages.join(", ")} look scanned and OCR is not available on this server.`],
               needsVisionOcr: true };
    }
    for (const [page, text] of ocr) {
      textSegments(text, "x").forEach((s, j) => segments.push({ ref: `page ${page}, line ${j + 1} (OCR)`, text: s.text, ocr: true }));
    }
    ocrUsed = true;
    const stillEmpty = emptyPages.filter((p) => !(ocr.get(p) ?? "").trim());
    if (stillEmpty.length) warnings.push(`No readable text found on page(s) ${stillEmpty.join(", ")}, even with OCR.`);
  }
  if (segments.length === 0) throw new FileRejected(`No readable text was found in "${name}".`);
  return { segments, ocrUsed, warnings, needsVisionOcr: false };
}

// ---------------------------------------------------------------- OCR (Tesseract, English + Arabic)
// Used when the `tesseract` and `pdftoppm` programs exist on the server. Otherwise
// scanned files are passed to the AI provider's document reader instead.
async function hasTool(cmd: string) {
  if (process.env.DISABLE_LOCAL_OCR === "1") return false;
  try { await execFile(cmd, ["--version"], { timeout: 5000 }); return true; } catch (e) {
    return (e as { code?: unknown }).code !== "ENOENT"; // exists but returned non-zero
  }
}

async function ocrImage(data: Buffer, name: string): Promise<string | null> {
  if (!(await hasTool("tesseract"))) return null;
  const dir = await mkdtemp(path.join(tmpdir(), "ocr-"));
  try {
    const file = path.join(dir, "img" + path.extname(name).toLowerCase());
    await writeFile(file, data);
    const { stdout } = await execFile("tesseract", [file, "stdout", "-l", "eng+ara"], { timeout: 120_000, maxBuffer: 20e6 });
    return stdout;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function ocrPdfPages(data: Buffer, pages: number[]): Promise<Map<number, string> | null> {
  if (!(await hasTool("tesseract")) || !(await hasTool("pdftoppm"))) return null;
  const dir = await mkdtemp(path.join(tmpdir(), "ocrpdf-"));
  const out = new Map<number, string>();
  try {
    const pdf = path.join(dir, "in.pdf");
    await writeFile(pdf, data);
    for (const p of pages.slice(0, 50)) {
      await execFile("pdftoppm", ["-r", "200", "-png", "-f", String(p), "-l", String(p), pdf, path.join(dir, `p${p}`)], { timeout: 60_000 });
      const img = (await readdir(dir)).find((f) => f.startsWith(`p${p}`) && f.endsWith(".png"));
      if (!img) continue;
      const { stdout } = await execFile("tesseract", [path.join(dir, img), "stdout", "-l", "eng+ara"], { timeout: 120_000, maxBuffer: 20e6 });
      out.set(p, stdout);
    }
    return out;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
