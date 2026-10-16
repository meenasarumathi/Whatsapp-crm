// ============================================================
// File storage on disk (UPLOAD_DIR). Replaces the hosted object-storage buckets.
//   <UPLOAD_DIR>/<bucket>/<path>   served publicly at  /api/files/<bucket>/<path>
// Buckets keep their old names and rules (size, MIME allow-list, who may write).
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";

export interface BucketRule {
  maxBytes: number;
  mime: readonly string[];
  /** Which first path segment a writer is allowed to use. */
  scope: "user" | "account";
}

const DOC_MIME = [
  "application/pdf", "application/vnd.ms-powerpoint", "application/msword", "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
];
const MEDIA_MIME = [
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/3gpp", "video/3gp", "video/quicktime",
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "audio/opus", "audio/webm",
  ...DOC_MIME,
];

export const BUCKETS: Record<string, BucketRule> = {
  avatars: { maxBytes: 2 * 1024 * 1024, mime: ["image/png", "image/jpeg", "image/webp", "image/gif"], scope: "user" },
  "chat-media": { maxBytes: 16 * 1024 * 1024, mime: MEDIA_MIME, scope: "account" },
  "flow-media": { maxBytes: 16 * 1024 * 1024, mime: MEDIA_MIME, scope: "account" },
};

export function uploadRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR || "./uploads");
}

export class StorageError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Validates bucket + object path and returns the absolute file location. */
export function resolveObject(bucket: string, objectPath: string): string {
  if (!BUCKETS[bucket]) throw new StorageError("Unknown bucket", 404);
  const parts = objectPath.split("/");
  if (parts.length === 0 || parts.some((p) => !p || p === "." || p === ".." || /[\\\0]/.test(p))) {
    throw new StorageError("Invalid path");
  }
  const root = path.join(uploadRoot(), bucket);
  const full = path.join(root, ...parts);
  if (!full.startsWith(root + path.sep)) throw new StorageError("Invalid path");
  return full;
}

export function normalizeMime(value?: string | null): string {
  return (value ?? "").split(";")[0].trim().toLowerCase();
}

export function checkUpload(bucket: string, size: number, contentType: string): void {
  const rule = BUCKETS[bucket];
  if (!rule) throw new StorageError("Unknown bucket", 404);
  if (size > rule.maxBytes) throw new StorageError("The file is too large for this bucket", 413);
  if (!rule.mime.includes(normalizeMime(contentType))) throw new StorageError(`Files of type ${contentType || "unknown"} are not allowed`, 415);
}

export function publicFileUrl(bucket: string, objectPath: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  return `${base}/api/files/${bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

export async function putObject(bucket: string, objectPath: string, body: Uint8Array, contentType: string, upsert = true): Promise<void> {
  checkUpload(bucket, body.byteLength, contentType);
  const file = resolveObject(bucket, objectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, body, { flag: upsert ? "w" : "wx" });
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") throw new StorageError("The resource already exists", 409);
    throw e;
  }
  await fs.writeFile(`${file}.meta`, JSON.stringify({ contentType: normalizeMime(contentType) }));
}

export async function removeObject(bucket: string, objectPath: string): Promise<void> {
  const file = resolveObject(bucket, objectPath);
  await fs.rm(file, { force: true });
  await fs.rm(`${file}.meta`, { force: true });
}

export async function readObject(bucket: string, objectPath: string): Promise<{ data: Buffer; contentType: string } | null> {
  const file = resolveObject(bucket, objectPath);
  try {
    const data = await fs.readFile(file);
    let contentType = "application/octet-stream";
    try {
      contentType = (JSON.parse(await fs.readFile(`${file}.meta`, "utf8")) as { contentType: string }).contentType || contentType;
    } catch {
      /* no sidecar */
    }
    return { data, contentType };
  } catch {
    return null;
  }
}

/** Server-side storage handle shaped like the old `storage` client (used by the webhook's media mirror). */
export function createDiskStorage() {
  return {
    from(bucket: string) {
      return {
        async upload(objectPath: string, body: Uint8Array | Buffer, opts: { contentType: string; cacheControl?: string; upsert?: boolean }) {
          try {
            await putObject(bucket, objectPath, body, opts.contentType, opts.upsert ?? true);
            return { error: null };
          } catch (e) {
            return { error: { message: e instanceof Error ? e.message : "Upload failed" } };
          }
        },
        getPublicUrl(objectPath: string) {
          return { data: { publicUrl: publicFileUrl(bucket, objectPath) } };
        },
      };
    },
  };
}
