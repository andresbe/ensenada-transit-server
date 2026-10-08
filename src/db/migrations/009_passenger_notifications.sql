BEGIN;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
UPDATE alerts SET published_at=created_at WHERE published AND published_at IS NULL;
CREATE TABLE IF NOT EXISTS passenger_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE, platform TEXT NOT NULL CHECK(platform IN ('android','ios')),
  active BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS notification_subscriptions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,route_id)
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES passenger_devices(id) ON DELETE CASCADE,
  alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','submitted','accepted','failed','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticket_id TEXT, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(device_id,alert_id,user_id)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_pending ON notification_deliveries(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS passenger_devices_owner ON passenger_devices(user_id);
COMMIT;
