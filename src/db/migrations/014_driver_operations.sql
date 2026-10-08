BEGIN;
ALTER TABLE conductores ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE conductores ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
GRANT SELECT(revision) ON conductores TO et_line_runtime;
DROP POLICY conductores_line_read ON conductores;
CREATE POLICY conductores_line_read ON conductores FOR SELECT TO et_line_runtime
  USING(EXISTS(SELECT 1 FROM driver_line_memberships m WHERE m.conductor_id=id AND et_can_access_line(m.line_id)));
CREATE INDEX driver_sessions_line_started_idx ON driver_sessions(transport_line_id,started_at DESC,id);
ALTER TABLE fleet_assignment_history ADD COLUMN route_id UUID REFERENCES routes(id);
ALTER TABLE fleet_assignment_history ADD COLUMN action TEXT NOT NULL DEFAULT 'assignment' CHECK(action IN ('create','assignment','archive','restore'));
ALTER TABLE fleet_assignment_history ADD COLUMN operational_status TEXT CHECK(operational_status IN ('available','maintenance','out_of_service'));
COMMIT;
