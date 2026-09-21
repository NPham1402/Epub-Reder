-- State a reader creates now lives in the database (so it is backed up and
-- follows the reader across devices); the browser keeps only a cache.

-- Progress: `chapter_idx`/`scroll_ratio` stay the *current* position (newest
-- device timestamp wins, used to resume); `furthest_*` only ever moves forward
-- (used for "% read"). `client_ts` is the device's own clock for the position.
ALTER TABLE progress ADD COLUMN furthest_idx INTEGER NOT NULL DEFAULT 0;
ALTER TABLE progress ADD COLUMN furthest_ratio REAL NOT NULL DEFAULT 0;
ALTER TABLE progress ADD COLUMN client_ts INTEGER NOT NULL DEFAULT 0;
UPDATE progress SET furthest_idx = chapter_idx, furthest_ratio = scroll_ratio, client_ts = updated_at;

-- Reader settings: one row per key, newest `updated_at` wins.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,             -- JSON
  updated_at INTEGER NOT NULL
);

-- Highlights: the whole set for one chapter is replaced together (newest wins).
-- An empty set is kept so that "removed everything" also propagates.
CREATE TABLE IF NOT EXISTS highlights (
  book_id     TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL,
  items       TEXT NOT NULL,            -- JSON [{p, start, end}]
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (book_id, chapter_idx)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL,
  p           INTEGER NOT NULL DEFAULT 0,   -- paragraph index in the chapter
  snippet     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(book_id);
