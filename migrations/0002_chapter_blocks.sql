-- Store each chapter's parsed blocks directly in D1 so chapters can be loaded
-- lazily (one at a time) instead of downloading the whole book at once.
ALTER TABLE chapters ADD COLUMN blocks TEXT;
