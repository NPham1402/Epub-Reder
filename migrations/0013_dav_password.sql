-- WebDAV password for vBook, set from the app instead of a cluster Secret.
-- Only a keyed hash (HMAC with SESSION_SECRET) is stored; one row.
CREATE TABLE IF NOT EXISTS dav_auth (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  digest     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
