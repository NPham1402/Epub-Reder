// Background housekeeping, run on a timer by the Node/Docker server.

import type { Env } from "./types";
import { abortIngest, busyBooks, contentBinKey, legacyContentKey, spineMetaKey } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;

// Removes books whose *first* ingest was started and never finished (a
// closed tab, a crash, a failed upload) so they don't sit in storage forever
// invisible — unfinished books are hidden from the library, so there's no UI
// to delete them. Deliberately limited to `ever_completed = 0`: a finished
// book that is being re-indexed also has ingest_done = 0, and deleting that
// would destroy the only copy of its raw .epub.
export async function cleanupStaleIngests(env: Env, olderThanMs = DAY_MS): Promise<string[]> {
  const cutoff = Date.now() - olderThanMs;
  const { results } = await env.DB.prepare(
    `SELECT id, r2_key, ingest_upload_id FROM books
     WHERE ingest_done = 0 AND ever_completed = 0 AND created_at < ?`,
  ).bind(cutoff).all<{ id: string; r2_key: string; ingest_upload_id: string | null }>();

  const removed: string[] = [];
  for (const b of results) {
    if (busyBooks.has(b.id)) continue;
    busyBooks.add(b.id);
    try {
      await abortIngest(env, b.id, b.ingest_upload_id);
      await env.BOOKS.delete([b.r2_key, contentBinKey(b.id), legacyContentKey(b.id), spineMetaKey(b.id)]);
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(b.id),
        env.DB.prepare(`DELETE FROM progress WHERE book_id = ?`).bind(b.id),
        env.DB.prepare(`DELETE FROM books WHERE id = ? AND ingest_done = 0 AND ever_completed = 0`).bind(b.id),
      ]);
      removed.push(b.id);
    } finally {
      busyBooks.delete(b.id);
    }
  }
  return removed;
}
