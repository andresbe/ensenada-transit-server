BEGIN;
CREATE TABLE passenger_boardings (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 vehicle_id UUID NOT NULL REFERENCES fleet_vehicles(id),
 driver_session_id UUID NOT NULL REFERENCES driver_sessions(id),
 route_id UUID NOT NULL REFERENCES routes(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','ended','expired')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '2 minutes',
 ended_at TIMESTAMPTZ,
 first_lat DOUBLE PRECISION NOT NULL CHECK(first_lat BETWEEN -90 AND 90),
 first_lng DOUBLE PRECISION NOT NULL CHECK(first_lng BETWEEN -180 AND 180),
 first_bus_lat DOUBLE PRECISION NOT NULL CHECK(first_bus_lat BETWEEN -90 AND 90),
 first_bus_lng DOUBLE PRECISION NOT NULL CHECK(first_bus_lng BETWEEN -180 AND 180),
 last_lat DOUBLE PRECISION NOT NULL CHECK(last_lat BETWEEN -90 AND 90),
 last_lng DOUBLE PRECISION NOT NULL CHECK(last_lng BETWEEN -180 AND 180),
 last_timestamp BIGINT NOT NULL,
 last_received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX passenger_boardings_one_active ON passenger_boardings(user_id) WHERE status IN ('pending','verified');
CREATE INDEX passenger_boardings_user_created ON passenger_boardings(user_id,created_at DESC);
CREATE INDEX passenger_boardings_vehicle_expiry ON passenger_boardings(vehicle_id,expires_at) WHERE status='verified';
REVOKE ALL ON passenger_boardings FROM PUBLIC;
COMMIT;
