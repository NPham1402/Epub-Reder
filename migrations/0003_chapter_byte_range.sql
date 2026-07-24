-- Byte-range storage: the whole book is one R2 object; each chapter occupies a
-- contiguous byte slice. These columns record where each chapter's bytes live so
-- a single chapter can be fetched with an R2 range request.
ALTER TABLE chapters ADD COLUMN byte_offset INTEGER;
ALTER TABLE chapters ADD COLUMN byte_length INTEGER;
