"use client";
// Browser storage client: uploads go to POST /api/storage/<bucket>, public URLs are /api/files/...

export interface BrowserStorage {
  from(bucket: string): {
    upload(path: string, file: Blob, opts?: { contentType?: string; cacheControl?: string; upsert?: boolean }): Promise<{ data: { path: string } | null; error: { message: string } | null }>;
    getPublicUrl(path: string): { data: { publicUrl: string } };
    remove(paths: string[]): Promise<{ data: null; error: { message: string } | null }>;
  };
}

const urlFor = (bucket: string, path: string) =>
  `${window.location.origin}/api/files/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`;

export function createStorageClient(): BrowserStorage {
  return {
    from(bucket) {
      return {
        async upload(path, file, opts) {
          const form = new FormData();
          const typed = opts?.contentType && file.type !== opts.contentType ? new Blob([file], { type: opts.contentType }) : file;
          form.set("file", typed, (file as File).name ?? "file");
          form.set("path", path);
          form.set("upsert", String(opts?.upsert ?? false));
          try {
            const res = await fetch(`/api/storage/${bucket}`, { method: "POST", body: form, credentials: "same-origin" });
            const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
            if (!res.ok) return { data: null, error: { message: json.error?.message ?? `Upload failed (${res.status})` } };
            return { data: { path }, error: null };
          } catch (e) {
            return { data: null, error: { message: e instanceof Error ? e.message : "Upload failed" } };
          }
        },
        getPublicUrl: (path) => ({ data: { publicUrl: urlFor(bucket, path) } }),
        async remove(paths) {
          try {
            const res = await fetch(`/api/storage/${bucket}`, {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ paths }),
              credentials: "same-origin",
            });
            const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
            return { data: null, error: res.ok ? null : { message: json.error?.message ?? "Delete failed" } };
          } catch (e) {
            return { data: null, error: { message: e instanceof Error ? e.message : "Delete failed" } };
          }
        },
      };
    },
  };
}
