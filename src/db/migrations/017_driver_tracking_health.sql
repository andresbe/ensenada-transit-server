BEGIN;
ALTER TABLE driver_sessions
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN last_gps_at timestamptz,
  ADD COLUMN tracking_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN tracking_samples jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE driver_sessions ADD CONSTRAINT tracking_samples_bounded CHECK(jsonb_typeof(tracking_samples)='array' AND jsonb_array_length(tracking_samples)<=1440);
CREATE INDEX driver_sessions_health_idx ON driver_sessions(last_heartbeat_at) WHERE status='active';
COMMIT;
