-- Resumable ingestion: a book's content is now (re)built across multiple
-- HTTP requests (see /api/books/:id/ingest-chunk) to stay under a Worker's
-- per-request CPU time limit for books with thousands of chapters. These
-- columns let each request pick up exactly where the last one left off.
-- Existing rows default to ingest_done = 1 (already fully ingested).
ALTER TABLE books ADD COLUMN ingest_done INTEGER NOT NULL DEFAULT 1;
ALTER TABLE books ADD COLUMN ingest_upload_id TEXT;
ALTER TABLE books ADD COLUMN ingest_part_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE books ADD COLUMN ingest_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE books ADD COLUMN ingest_parts_json TEXT NOT NULL DEFAULT '[]';
