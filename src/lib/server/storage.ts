import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { supabaseClient } from "./auth";

// Private file storage. Object keys always begin with the company id.
// Callers must have already confirmed (through RLS-checked queries) that the
// user belongs to that company; Supabase storage policies enforce it again.

const BUCKET = "inquiry-files";
const isLocalStorage = () => (process.env.STORAGE_DRIVER ?? "supabase") === "local";
const LOCAL_ROOT = path.join(/*turbopackIgnore: true*/ process.cwd(), process.env.LOCAL_STORAGE_DIR ?? ".local-storage");

function safeKey(key: string) {
  if (!/^[0-9a-f-]{36}\/[\w\-./]+$/i.test(key) || key.includes("..")) throw new Error("Invalid storage key");
  return key;
}

export async function putObject(key: string, data: Buffer, contentType: string) {
  key = safeKey(key);
  if (isLocalStorage()) {
    const file = path.join(LOCAL_ROOT, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    return;
  }
  const sb = await supabaseClient();
  const { error } = await sb.storage.from(BUCKET).upload(key, data, { contentType, upsert: true });
  if (error) throw new Error(`File storage failed: ${error.message}`);
}

export async function getObject(key: string): Promise<Buffer> {
  key = safeKey(key);
  if (isLocalStorage()) return readFile(path.join(LOCAL_ROOT, key));
  const sb = await supabaseClient();
  const { data, error } = await sb.storage.from(BUCKET).download(key);
  if (error || !data) throw new Error("File could not be read from storage.");
  return Buffer.from(await data.arrayBuffer());
}

export async function deleteObjects(keys: string[]) {
  if (keys.length === 0) return;
  keys = keys.map(safeKey);
  if (isLocalStorage()) {
    await Promise.all(keys.map((k) => rm(path.join(LOCAL_ROOT, k), { force: true })));
    return;
  }
  const sb = await supabaseClient();
  await sb.storage.from(BUCKET).remove(keys);
}

/** Short-lived link (60 s) for downloads, or null when files are streamed by our own route. */
export async function signedUrl(key: string, fileName: string): Promise<string | null> {
  if (isLocalStorage()) return null;
  const sb = await supabaseClient();
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(safeKey(key), 60, { download: fileName });
  if (error) throw new Error("Could not create a download link.");
  return data.signedUrl;
}
