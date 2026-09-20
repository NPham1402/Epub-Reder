-- Small app-wide key/value state. `session_epoch` is baked into every session
-- token; bumping it ("sign out everywhere") invalidates all outstanding
-- sessions, which a purely stateless HMAC cookie otherwise can't do.
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_state (key, value) VALUES ('session_epoch', '1');

-- 0 = this book has never finished its first ingest (safe to garbage-collect
-- if abandoned). 1 = it has, so a later ingest_done = 0 means a re-index in
-- progress, which must NEVER be garbage-collected (it would delete the only
-- copy of the raw .epub). Existing rows default to 1, the safe direction.
ALTER TABLE books ADD COLUMN ever_completed INTEGER NOT NULL DEFAULT 1;
