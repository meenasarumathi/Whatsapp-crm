import { StorageError, readObject } from "@/lib/storage/disk";

export const runtime = "nodejs";

/**
 * Public file download (the old buckets were public; WhatsApp fetches
 * outbound media by URL). Object names carry a timestamp / random part, so
 * they are not guessable.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ bucket: string; path: string[] }> }) {
  try {
    const { bucket, path } = await params;
    const obj = await readObject(bucket, path.map(decodeURIComponent).join("/"));
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(obj.data), {
      headers: {
        "content-type": obj.contentType,
        "content-length": String(obj.data.length),
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    if (e instanceof StorageError) return new Response(e.message, { status: e.status });
    return new Response("Error", { status: 500 });
  }
}
