-- Books: one row per uploaded EPUB.
CREATE TABLE IF NOT EXISTS books (
  id            TEXT PRIMARY KEY,           -- uuid
  title         TEXT NOT NULL,
  author        TEXT,
  language      TEXT,
  r2_key        TEXT NOT NULL,              -- key of the raw .epub in R2
  code_name     TEXT NOT NULL,              -- disguised "repository" name
  chapter_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL            -- epoch ms
);

-- Chapters: reading-order sections. Parsed content lives in R2 (content_key).
CREATE TABLE IF NOT EXISTS chapters (
  book_id      TEXT NOT NULL,
  idx          INTEGER NOT NULL,            -- 0-based reading order
  title        TEXT,
  file_name    TEXT NOT NULL,               -- disguised source file name
  content_key  TEXT NOT NULL,               -- R2 key of parsed JSON blocks
  char_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, idx),
  FOREIGN KEY (book_id) REFERENCES books(id)
);

-- Reading progress: one row per book.
CREATE TABLE IF NOT EXISTS progress (
  book_id      TEXT PRIMARY KEY,
  chapter_idx  INTEGER NOT NULL DEFAULT 0,
  scroll_ratio REAL NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
