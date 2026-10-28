-- Validate new writes without silently reassigning historical alerts.
-- Deferred checks preserve the existing SET NULL behavior when routes/stops are deleted.
ALTER TABLE stops ADD CONSTRAINT stops_id_route_unique UNIQUE(id,route_id);
ALTER TABLE alerts ADD CONSTRAINT alerts_stop_route_fk
  FOREIGN KEY(stop_id,route_id) REFERENCES stops(id,route_id)
  DEFERRABLE INITIALLY DEFERRED NOT VALID;

CREATE FUNCTION et_validate_alert_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a alerts%ROWTYPE; owner_line uuid;
BEGIN
  SELECT * INTO a FROM alerts WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF a.stop_id IS NOT NULL AND a.route_id IS NULL THEN
    RAISE EXCEPTION 'Alert stop requires its route' USING ERRCODE='23514';
  END IF;
  IF a.route_id IS NOT NULL THEN
    SELECT transport_line_id INTO owner_line FROM routes WHERE id=a.route_id;
    IF NOT FOUND OR owner_line IS DISTINCT FROM a.transport_line_id THEN
      RAISE EXCEPTION 'Alert target belongs to another line' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER alerts_validate_target AFTER INSERT OR UPDATE ON alerts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION et_validate_alert_target();

CREATE FUNCTION et_validate_route_alert_owners() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM alerts a JOIN routes r ON r.id=a.route_id
    WHERE r.id=NEW.id AND a.transport_line_id IS DISTINCT FROM r.transport_line_id) THEN
    RAISE EXCEPTION 'Route has alerts belonging to another line' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER routes_validate_alert_owners AFTER UPDATE ON routes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.transport_line_id IS DISTINCT FROM NEW.transport_line_id)
  EXECUTE FUNCTION et_validate_route_alert_owners();
