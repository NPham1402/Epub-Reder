-- vBook reading sessions (read_histories.json in its backup) already added to
-- reading_hourly, so importing a newer backup never counts a session twice.
CREATE TABLE IF NOT EXISTS vbook_sessions (
  id          TEXT PRIMARY KEY,
  imported_at INTEGER NOT NULL
);
