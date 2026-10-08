-- Additive passenger API migration. Existing route/favorite endpoints remain valid.
BEGIN;

CREATE TABLE IF NOT EXISTS transport_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
  short_code TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#2563FF',
  display_order INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE
);
ALTER TABLE routes ADD COLUMN IF NOT EXISTS transport_line_id UUID REFERENCES transport_lines(id);
ALTER TABLE routes ADD COLUMN IF NOT EXISTS operating_hours JSONB;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS service_days INTEGER[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6];
ALTER TABLE routes ADD COLUMN IF NOT EXISTS service_timezone TEXT NOT NULL DEFAULT 'America/Tijuana';
ALTER TABLE routes ADD COLUMN IF NOT EXISTS estimated_cycle_minutes INTEGER;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS neighborhood_names TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE routes ADD COLUMN IF NOT EXISTS visible_in_app BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS route_legacy_aliases (
  legacy_id TEXT PRIMARY KEY, route_id UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS variant_legacy_aliases (
  legacy_id TEXT PRIMARY KEY, variant_id UUID NOT NULL REFERENCES route_variants(id) ON DELETE CASCADE
);
-- Shared physical stop identity is optional during migration. Existing associations survive.
CREATE TABLE IF NOT EXISTS physical_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180)
);
ALTER TABLE stops ADD COLUMN IF NOT EXISTS physical_stop_id UUID REFERENCES physical_stops(id);

CREATE TABLE IF NOT EXISTS saved_journeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES route_variants(id) ON DELETE CASCADE,
  destination_title TEXT, destination_latitude DOUBLE PRECISION, destination_longitude DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), client_id TEXT NOT NULL,
  UNIQUE(user_id, client_id),
  CHECK ((destination_latitude IS NULL AND destination_longitude IS NULL) OR
    (destination_latitude IS NOT NULL AND destination_longitude IS NOT NULL AND destination_latitude BETWEEN -90 AND 90 AND destination_longitude BETWEEN -180 AND 180))
);
CREATE TABLE IF NOT EXISTS saved_places (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('home','work','custom')),
  latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  client_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,client_id)
);
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS stop_id UUID REFERENCES stops(id) ON DELETE SET NULL;
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'moderate';
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS user_reports_client_id ON user_reports(user_id,client_id) WHERE client_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), route_id UUID REFERENCES routes(id) ON DELETE SET NULL,
  stop_id UUID REFERENCES stops(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK(category IN ('routes','stops','service','news')),
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
  title_es TEXT NOT NULL, description_es TEXT NOT NULL, title_en TEXT, description_en TEXT,
  published BOOLEAN NOT NULL DEFAULT FALSE, starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(expires_at > starts_at)
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', client_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,client_id)
);
CREATE TABLE IF NOT EXISTS passenger_trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES routes(id), variant_id UUID REFERENCES route_variants(id), bus_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ended_at TIMESTAMPTZ, client_id TEXT NOT NULL,
  UNIQUE(user_id,client_id)
);
CREATE TABLE IF NOT EXISTS passenger_trip_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), trip_id UUID NOT NULL REFERENCES passenger_trips(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('boarding','alighting','completed','cancelled')),
  client_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(trip_id,client_id)
);
CREATE INDEX IF NOT EXISTS alerts_active_window ON alerts(published,starts_at,expires_at);
CREATE INDEX IF NOT EXISTS passenger_trips_owner ON passenger_trips(user_id,started_at DESC);
CREATE INDEX IF NOT EXISTS saved_journeys_owner ON saved_journeys(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS saved_places_owner ON saved_places(user_id,created_at DESC);
-- Preserve existing account favorites. Legacy endpoints and rows remain available.
INSERT INTO saved_journeys(user_id,route_id,client_id)
SELECT user_id,route_id,'legacy-route:' || route_id::text FROM favorite_routes
ON CONFLICT(user_id,client_id) DO NOTHING;
COMMIT;
