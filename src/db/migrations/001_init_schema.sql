-- ============================================================
-- Ensenada Transit – initial database schema
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Helper: auto-update updated_at ───────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── users ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT        UNIQUE,
  password_hash    TEXT,
  display_name     TEXT,
  photo_url        TEXT,
  auth_provider    TEXT        NOT NULL DEFAULT 'email',  -- email | google | apple | guest
  role             TEXT        NOT NULL DEFAULT 'user',   -- user | driver | admin
  status           TEXT        NOT NULL DEFAULT 'active', -- active | suspended | deleted
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email  ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── user_preferences ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id                    UUID    PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  language                   TEXT    NOT NULL DEFAULT 'es',
  push_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  favorite_route_alerts      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_user_preferences_updated_at ON user_preferences;
CREATE TRIGGER trg_user_preferences_updated_at
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── routes ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routes (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT    NOT NULL,
  short_name  TEXT    NOT NULL,
  color       TEXT    NOT NULL DEFAULT '#000000',
  text_color  TEXT    NOT NULL DEFAULT '#FFFFFF',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routes_active ON routes (active);

DROP TRIGGER IF EXISTS trg_routes_updated_at ON routes;
CREATE TRIGGER trg_routes_updated_at
  BEFORE UPDATE ON routes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── route_variants ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS route_variants (
  id                     UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id               UUID    NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  name                   TEXT    NOT NULL,
  direction              TEXT    NOT NULL, -- ida | vuelta
  coordinates            JSONB   NOT NULL DEFAULT '[]',
  total_distance_meters  NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_variants_route_id  ON route_variants (route_id);
CREATE INDEX IF NOT EXISTS idx_route_variants_direction ON route_variants (direction);

DROP TRIGGER IF EXISTS trg_route_variants_updated_at ON route_variants;
CREATE TRIGGER trg_route_variants_updated_at
  BEFORE UPDATE ON route_variants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── stops ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stops (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id    UUID    NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  variant_id  UUID    NOT NULL REFERENCES route_variants (id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  latitude    NUMERIC(10, 7) NOT NULL,
  longitude   NUMERIC(10, 7) NOT NULL,
  sequence    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stops_route_id   ON stops (route_id);
CREATE INDEX IF NOT EXISTS idx_stops_variant_id ON stops (variant_id);

DROP TRIGGER IF EXISTS trg_stops_updated_at ON stops;
CREATE TRIGGER trg_stops_updated_at
  BEFORE UPDATE ON stops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── favorite_routes ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS favorite_routes (
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  route_id   UUID NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, route_id)
);

CREATE INDEX IF NOT EXISTS idx_favorite_routes_user_id ON favorite_routes (user_id);

-- ── favorite_stops ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS favorite_stops (
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stop_id    UUID NOT NULL REFERENCES stops (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, stop_id)
);

CREATE INDEX IF NOT EXISTS idx_favorite_stops_user_id ON favorite_stops (user_id);

-- ── user_reports ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_reports (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        TEXT    NOT NULL, -- crowded | breakdown | delay | other
  route_id    UUID    REFERENCES routes (id) ON DELETE SET NULL,
  variant_id  UUID    REFERENCES route_variants (id) ON DELETE SET NULL,
  bus_id      TEXT,
  message     TEXT,
  latitude    NUMERIC(10, 7),
  longitude   NUMERIC(10, 7),
  status      TEXT    NOT NULL DEFAULT 'open', -- open | reviewed | resolved
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_reports_user_id  ON user_reports (user_id);
CREATE INDEX IF NOT EXISTS idx_user_reports_route_id ON user_reports (route_id);
CREATE INDEX IF NOT EXISTS idx_user_reports_status   ON user_reports (status);

DROP TRIGGER IF EXISTS trg_user_reports_updated_at ON user_reports;
CREATE TRIGGER trg_user_reports_updated_at
  BEFORE UPDATE ON user_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── driver_sessions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_sessions (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   UUID    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  bus_id      TEXT    NOT NULL,
  route_id    UUID    REFERENCES routes (id) ON DELETE SET NULL,
  variant_id  UUID    REFERENCES route_variants (id) ON DELETE SET NULL,
  status      TEXT    NOT NULL DEFAULT 'active', -- active | ended
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_sessions_driver_id ON driver_sessions (driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_sessions_status    ON driver_sessions (status);
CREATE INDEX IF NOT EXISTS idx_driver_sessions_bus_id    ON driver_sessions (bus_id);

DROP TRIGGER IF EXISTS trg_driver_sessions_updated_at ON driver_sessions;
CREATE TRIGGER trg_driver_sessions_updated_at
  BEFORE UPDATE ON driver_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
