BEGIN;
ALTER TABLE driver_sessions ADD COLUMN direction_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE driver_sessions ADD COLUMN last_location JSONB;
COMMIT;
