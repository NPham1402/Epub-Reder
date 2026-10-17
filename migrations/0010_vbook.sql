-- Books that came from a vBook backup keep vBook's own book id, so importing a
-- newer backup updates them instead of creating a duplicate, and their chapter
-- order matches vBook's table of contents one-to-one (progress maps exactly).
-- vbook_json is vBook's book record (without the long description), kept for
-- writing progress back to vBook later.
ALTER TABLE books ADD COLUMN vbook_id TEXT;
ALTER TABLE books ADD COLUMN vbook_json TEXT;
CREATE INDEX IF NOT EXISTS idx_books_vbook ON books(vbook_id);
