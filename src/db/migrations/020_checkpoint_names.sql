BEGIN;
ALTER TABLE route_checkpoints ADD COLUMN name TEXT
  CHECK (name IS NULL OR (char_length(btrim(name)) BETWEEN 1 AND 100 AND name = btrim(name)));
COMMIT;
