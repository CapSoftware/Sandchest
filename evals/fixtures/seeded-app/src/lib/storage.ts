import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const ATTACHMENT_ROOT = resolve(process.env.ATTACHMENT_DIR ?? "./data/attachments");
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "text/csv"]);

export function attachmentPath(orgId: string, name: string): string {
  const orgDir = resolve(ATTACHMENT_ROOT, orgId);
  const full = resolve(orgDir, basename(name));
  if (!full.startsWith(orgDir + sep)) {
    throw new Error("Invalid attachment path");
  }
  return full;
}

export async function saveAttachment(orgId: string, file: File): Promise<{ name: string; size: number }> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("File too large");
  if (!ALLOWED_TYPES.has(file.type)) throw new Error("Unsupported file type");
  const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
  const name = `${randomUUID()}${extension.replace(/[^.a-z0-9]/g, "")}`;
  await mkdir(join(ATTACHMENT_ROOT, orgId), { recursive: true });
  await writeFile(attachmentPath(orgId, name), Buffer.from(await file.arrayBuffer()));
  return { name, size: file.size };
}

export async function readAttachment(relativePath: string): Promise<{ data: Buffer; size: number }> {
  const full = join(ATTACHMENT_ROOT, relativePath);
  const info = await stat(full);
  return { data: await readFile(full), size: info.size };
}

export function contentTypeFor(name: string): string {
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}
