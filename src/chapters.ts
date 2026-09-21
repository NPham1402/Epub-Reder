// Reads a chapter's stored text blocks. Shared by the chapter route, export
// and the search index.

import type { Env } from "./types";
import { contentBinKey } from "./storage";

export interface ChapterRow {
  idx: number;
  title: string | null;
  file_name: string;
  byte_offset: number | null;
  byte_length: number | null;
  blocks: string | null;
}
export interface StoredBlock { type: string; text: string }

export async function readBlocks(env: Env, bookId: string, row: Pick<ChapterRow, "byte_offset" | "byte_length" | "blocks">): Promise<StoredBlock[]> {
  let blocks: unknown = [];
  if (row.byte_offset != null && row.byte_length != null && row.byte_length > 0) {
    const obj = await env.BOOKS.get(contentBinKey(bookId), { range: { offset: row.byte_offset, length: row.byte_length } });
    if (obj) { try { blocks = JSON.parse(await obj.text()); } catch { /* unreadable: treat as empty */ } }
  } else if (row.blocks) {
    // Fallback for a book still stored in the earlier per-row D1 format.
    try { blocks = JSON.parse(row.blocks); } catch { /* same */ }
  }
  return Array.isArray(blocks) ? (blocks as StoredBlock[]) : [];
}
