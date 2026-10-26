// ============================================================
// Private storage for GPay recharge proofs (server only).
//
//   <UPLOAD_DIR>/private/recharge-proofs/<account_id>/<uuid>.<ext>
//
// Deliberately NOT a bucket in lib/storage/disk.ts: those are served
// publicly at /api/files/<bucket>/..., and a proof must never be. The
// only way to read one is GET /api/wallet/admin/proof/[id], which checks
// the caller first.
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeMime, uploadRoot } from "@/lib/storage/disk";
import { PROOF_BUCKET } from "./units";

const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|pdf)$/i;

function proofPath(key: string): string {
  if (!KEY_RE.test(key)) throw new Error("Invalid proof key");
  return path.join(uploadRoot(), "private", PROOF_BUCKET, ...key.split("/"));
}

export async function putProof(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const file = proofPath(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, { flag: "wx" });
  await fs.writeFile(`${file}.meta`, JSON.stringify({ contentType: normalizeMime(contentType) }));
}

export async function removeProof(key: string): Promise<void> {
  const file = proofPath(key);
  await fs.rm(file, { force: true });
  await fs.rm(`${file}.meta`, { force: true });
}

export async function readProof(key: string): Promise<{ data: Buffer; contentType: string } | null> {
  let file: string;
  try {
    file = proofPath(key);
  } catch {
    return null;
  }
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
