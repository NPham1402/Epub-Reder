-- How many of a vBook-imported book's chapters had text at its last import,
-- so a newer backup with more downloaded chapters (or a longer table of
-- contents) defaults to refreshing the content instead of only the position.
ALTER TABLE books ADD COLUMN vbook_downloaded INTEGER;
