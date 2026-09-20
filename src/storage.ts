// Object-storage key layout and the small pieces of ingest bookkeeping shared
// by the request handlers (index.ts) and the background maintenance
// (maintenance.ts).

import type { Env } from "./types";

export const contentBinKey = (id: string) => `books/${id}/content.bin`;
export const legacyContentKey = (id: string) => `books/${id}/content.json`;
export const spineMetaKey = (id: string) => `books/${id}/_spine.json`;
export const stagedPrefix = (id: string) => `books/${id}/_staged/`;
export const stagedKey = (id: string, offset: number) =>
  `${stagedPrefix(id)}${String(offset).padStart(12, "0")}.bin`;

// Books with an ingest/reindex/delete currently running in this process. Two
// overlapping requests for the same book would both read the same resume
// cursor and race on the multipart state, so the mutating routes refuse
// (409) while one is in flight. In-process only: on Cloudflare Workers each
// isolate has its own copy, so there it narrows the window rather than
// closing it — the Node/Docker server is a single process and closes it.
export const busyBooks = new Set<string>();

// Aborts a book's in-progress multipart upload (if any) and clears any
// staged-but-not-yet-consolidated objects. Used before re-indexing, before
// deleting a book that was left mid-ingest, and by the stale-ingest cleanup.
export async function abortIngest(env: Env, id: string, uploadId: string | null): Promise<void> {
  if (uploadId) {
    try { await env.BOOKS.resumeMultipartUpload(contentBinKey(id), uploadId).abort(); } catch {}
  }
  try {
    const { objects } = await env.BOOKS.list({ prefix: stagedPrefix(id) });
    if (objects.length) await env.BOOKS.delete(objects.map((o) => o.key));
  } catch {}
}
