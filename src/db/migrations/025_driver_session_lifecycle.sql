ALTER TABLE driver_sessions ADD COLUMN IF NOT EXISTS start_request_id text;
ALTER TABLE driver_sessions ADD COLUMN IF NOT EXISTS start_request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS driver_session_start_conductor ON driver_sessions(conductor_id, start_request_id) WHERE conductor_id IS NOT NULL AND start_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS driver_session_start_user ON driver_sessions(driver_id, start_request_id) WHERE driver_id IS NOT NULL AND start_request_id IS NOT NULL;
