BEGIN;
-- Preserve email login and the bus_id contract used by existing clients.
ALTER TABLE conductores ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE conductores ADD CONSTRAINT conductores_id_unique UNIQUE(id);
CREATE TABLE fleet_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text CHECK(length(btrim(tracking_id)) BETWEEN 1 AND 100),
  economic_number TEXT NOT NULL CHECK(length(btrim(economic_number)) BETWEEN 1 AND 40),
  transport_line_id UUID REFERENCES transport_lines(id),
  plate TEXT CHECK(plate IS NULL OR length(btrim(plate)) BETWEEN 1 AND 20),
  capacity INTEGER CHECK(capacity BETWEEN 1 AND 200),
  operational_status TEXT NOT NULL DEFAULT 'available' CHECK(operational_status IN ('available','maintenance','out_of_service')),
  assigned_driver_id UUID REFERENCES conductores(id),
  archived_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id,tracking_id)
);
-- Retired units retain their identity and history.
CREATE UNIQUE INDEX fleet_economic_number_unique ON fleet_vehicles(lower(btrim(economic_number)));
CREATE UNIQUE INDEX fleet_plate_unique ON fleet_vehicles(upper(regexp_replace(plate,'[^a-zA-Z0-9]','','g'))) WHERE plate IS NOT NULL;
CREATE UNIQUE INDEX fleet_driver_unique ON fleet_vehicles(assigned_driver_id) WHERE archived_at IS NULL;
CREATE INDEX fleet_line_idx ON fleet_vehicles(transport_line_id);
CREATE TABLE fleet_assignment_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_id UUID NOT NULL REFERENCES fleet_vehicles(id),
  conductor_id UUID REFERENCES conductores(id), admin_id UUID NOT NULL REFERENCES admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fleet_assignment_vehicle_idx ON fleet_assignment_history(vehicle_id,created_at);
ALTER TABLE driver_sessions ALTER COLUMN driver_id DROP NOT NULL;
ALTER TABLE driver_sessions ADD COLUMN conductor_id UUID REFERENCES conductores(id);
ALTER TABLE driver_sessions ADD COLUMN vehicle_id UUID;
ALTER TABLE driver_sessions ADD CONSTRAINT driver_sessions_identity_check CHECK(num_nonnulls(driver_id,conductor_id)=1);
ALTER TABLE driver_sessions ADD CONSTRAINT driver_sessions_vehicle_fk FOREIGN KEY(vehicle_id,bus_id) REFERENCES fleet_vehicles(id,tracking_id);
CREATE UNIQUE INDEX driver_sessions_active_vehicle_unique ON driver_sessions(vehicle_id) WHERE status='active';
CREATE UNIQUE INDEX driver_sessions_active_conductor_unique ON driver_sessions(conductor_id) WHERE status='active';
COMMIT;
