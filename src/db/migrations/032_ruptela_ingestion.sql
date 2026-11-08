-- Ruptela Eco5 Lite+ support. Keep the 029/030 registries and location history intact.
SET LOCAL lock_timeout = '5s';

-- Hardware providers share the append-only history/outbox. Existing rows remain unchanged.
ALTER TABLE vehicle_gps_locations
  DROP CONSTRAINT vehicle_gps_locations_source_check,
  DROP CONSTRAINT vehicle_gps_locations_source_shape_check;
ALTER TABLE vehicle_gps_locations
  ADD CONSTRAINT vehicle_gps_locations_source_check
    CHECK(source IN ('ANDROID','TELTONIKA','RUPTELA')) NOT VALID,
  ADD CONSTRAINT vehicle_gps_locations_source_shape_check CHECK(
    (source IN ('TELTONIKA','RUPTELA') AND device_id IS NOT NULL)
    OR (source='ANDROID' AND device_id IS NULL AND vehicle_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE vehicle_gps_locations
  VALIDATE CONSTRAINT vehicle_gps_locations_source_check;
ALTER TABLE vehicle_gps_locations
  VALIDATE CONSTRAINT vehicle_gps_locations_source_shape_check;

-- Optional bounded raw capture for an already-authorized device. Disabled by default in the
-- receiver; no packet bytes are emitted to logs or exposed through the public API.
CREATE TABLE tracking_device_packet_diagnostics (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider    TEXT NOT NULL CHECK(provider IN ('TELTONIKA','RUPTELA')),
  device_id   UUID NOT NULL REFERENCES tracking_devices(id) ON DELETE RESTRICT,
  command     SMALLINT NOT NULL CHECK(command BETWEEN 0 AND 255),
  packet_hash TEXT NOT NULL CHECK(packet_hash ~ '^[a-f0-9]{64}$'),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 1024),
  reason      TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 80),
  raw_packet  BYTEA CHECK(raw_packet IS NULL OR octet_length(raw_packet) <= 1024),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  CHECK(raw_packet IS NULL OR octet_length(raw_packet)=byte_length),
  CHECK(expires_at > received_at),
  UNIQUE(provider,device_id,packet_hash,reason)
);
CREATE INDEX tracking_device_packet_diagnostics_expiry_idx
  ON tracking_device_packet_diagnostics(expires_at);
CREATE INDEX tracking_device_packet_diagnostics_device_time_idx
  ON tracking_device_packet_diagnostics(device_id,received_at DESC,id DESC);
COMMENT ON TABLE tracking_device_packet_diagnostics IS
  'Bounded, temporary protocol diagnostics for authorized hardware. Receiver capture is opt-in; rows expire and are capped per device.';

REVOKE ALL ON tracking_device_packet_diagnostics FROM PUBLIC,et_line_runtime;
ALTER TABLE tracking_device_packet_diagnostics ENABLE ROW LEVEL SECURITY;
