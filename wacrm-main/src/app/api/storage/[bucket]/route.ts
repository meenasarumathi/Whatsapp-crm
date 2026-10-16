import { NextResponse } from "next/server";

import { getSessionUserId } from "@/lib/auth/session";
import { createUserDb } from "@/lib/db/client";
import { BUCKETS, StorageError, publicFileUrl, putObject, removeObject } from "@/lib/storage/disk";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ bucket: string }> };

/** The caller may only touch `<user id>/…` (avatars) or `account-<id>/…` of an account they belong to. */
async function authorize(bucket: string, objectPath: string, userId: string): Promise<void> {
  const rule = BUCKETS[bucket];
  if (!rule) throw new StorageError("Unknown bucket", 404);
  const first = objectPath.split("/")[0] ?? "";
  if (rule.scope === "user") {
    if (first !== userId) throw new StorageError("Not allowed", 403);
    return;
  }
  const m = first.match(/^account-([0-9a-f-]{36})$/i);
  if (!m) throw new StorageError("Not allowed", 403);
  const db = await createUserDb();
  const { data } = await db.rpc("is_account_member", { target_account_id: m[1] });
  if (data !== true) throw new StorageError("Not allowed", 403);
}

function fail(e: unknown) {
  if (e instanceof StorageError) return NextResponse.json({ error: { message: e.message } }, { status: e.status });
  console.error("[storage]", e);
  return NextResponse.json({ error: { message: "Storage error" } }, { status: 500 });
}

/** multipart/form-data: file, path, upsert? */
export async function POST(request: Request, { params }: Ctx) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: { message: "Not authenticated" } }, { status: 401 });
  try {
    const { bucket } = await params;
    const form = await request.formData();
    const file = form.get("file");
    const objectPath = String(form.get("path") ?? "");
    if (!(file instanceof File) || !objectPath) throw new StorageError("file and path are required");
    await authorize(bucket, objectPath, userId);
    await putObject(bucket, objectPath, new Uint8Array(await file.arrayBuffer()), file.type, form.get("upsert") === "true");
    return NextResponse.json({ path: objectPath, publicUrl: publicFileUrl(bucket, objectPath) });
  } catch (e) {
    return fail(e);
  }
}

/** JSON body { paths: string[] } */
export async function DELETE(request: Request, { params }: Ctx) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: { message: "Not authenticated" } }, { status: 401 });
  try {
    const { bucket } = await params;
    const body = (await request.json().catch(() => ({}))) as { paths?: unknown };
    const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string") : [];
    for (const p of paths) {
      await authorize(bucket, p, userId);
      await removeObject(bucket, p);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
