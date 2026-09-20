-- Uploads are sent in small parts so a slow or flaky connection never needs a
-- single long request (proxies in front cut those off, leaving a truncated
-- file). This tracks each upload until it is assembled into a book.
-- `book_id` is set once assembled, so a client retrying "complete" after a lost
-- response gets the same book back instead of creating a duplicate.
CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  part_size  INTEGER NOT NULL,
  name       TEXT,
  created_at INTEGER NOT NULL,
  book_id    TEXT
);
