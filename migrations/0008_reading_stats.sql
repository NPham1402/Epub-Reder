-- Time spent in the reader, in seconds, per (local day, local hour, book).
-- Only durations are stored, never any text. `day` and `hour` come from the
-- device's own clock, so "Tuesday evening" means the reader's evening.
-- Rows are kept when a book is deleted: it is still time that was spent.
CREATE TABLE IF NOT EXISTS reading_hourly (
  day     TEXT NOT NULL,             -- YYYY-MM-DD
  hour    INTEGER NOT NULL,          -- 0..23
  book_id TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  PRIMARY KEY (day, hour, book_id)
);
