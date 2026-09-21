-- How far each book's full-text index has got. The index itself (an FTS5 table)
-- is created the first time search is used, not here, so a database engine
-- without FTS5 only loses search instead of failing to start.
CREATE TABLE IF NOT EXISTS search_state (
  book_id      TEXT PRIMARY KEY,
  indexed_upto INTEGER NOT NULL DEFAULT 0,   -- chapters [0, indexed_upto) are indexed
  total        INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
