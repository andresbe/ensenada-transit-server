BEGIN;
ALTER TABLE admins ADD COLUMN is_superadmin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE transport_lines ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
CREATE TABLE admin_line_memberships (
  admin_id UUID NOT NULL REFERENCES admins(id), line_id UUID NOT NULL REFERENCES transport_lines(id),
  role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),
  active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(admin_id,line_id)
);
CREATE INDEX admin_memberships_line_idx ON admin_line_memberships(line_id);
CREATE TABLE driver_line_memberships (
  conductor_id UUID NOT NULL REFERENCES conductores(id), line_id UUID NOT NULL REFERENCES transport_lines(id),
  active BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY(conductor_id,line_id)
);
CREATE INDEX driver_memberships_line_idx ON driver_line_memberships(line_id);
-- Import only relationships already explicitly recorded; never guess a line.
INSERT INTO driver_line_memberships(conductor_id,line_id)
SELECT DISTINCT assigned_driver_id,transport_line_id FROM fleet_vehicles
WHERE assigned_driver_id IS NOT NULL AND transport_line_id IS NOT NULL;
ALTER TABLE routes ADD CONSTRAINT routes_id_line_unique UNIQUE(id,transport_line_id);
ALTER TABLE fleet_vehicles ADD COLUMN assigned_route_id UUID;
ALTER TABLE fleet_vehicles ADD CONSTRAINT fleet_id_line_unique UNIQUE(id,transport_line_id);
ALTER TABLE fleet_vehicles ADD CONSTRAINT fleet_route_line_fk FOREIGN KEY(assigned_route_id,transport_line_id) REFERENCES routes(id,transport_line_id);
ALTER TABLE fleet_vehicles ADD CONSTRAINT fleet_driver_line_fk FOREIGN KEY(assigned_driver_id,transport_line_id) REFERENCES driver_line_memberships(conductor_id,line_id);
DROP INDEX fleet_economic_number_unique;
CREATE UNIQUE INDEX fleet_economic_number_line_unique ON fleet_vehicles(transport_line_id,lower(btrim(economic_number))) WHERE transport_line_id IS NOT NULL;
CREATE UNIQUE INDEX fleet_economic_number_unassigned_unique ON fleet_vehicles(lower(btrim(economic_number))) WHERE transport_line_id IS NULL;
CREATE TABLE line_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), line_id UUID REFERENCES transport_lines(id),
  actor_id UUID REFERENCES admins(id), action TEXT NOT NULL, entity_type TEXT NOT NULL,
  entity_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX line_audit_line_time_idx ON line_audit_log(line_id,created_at DESC);
ALTER TABLE driver_sessions ADD COLUMN transport_line_id UUID REFERENCES transport_lines(id);
UPDATE driver_sessions s SET transport_line_id=v.transport_line_id FROM fleet_vehicles v WHERE s.vehicle_id=v.id;
ALTER TABLE driver_sessions ADD CONSTRAINT session_vehicle_line_fk FOREIGN KEY(vehicle_id,transport_line_id) REFERENCES fleet_vehicles(id,transport_line_id);
ALTER TABLE driver_sessions ADD CONSTRAINT session_route_line_fk FOREIGN KEY(route_id,transport_line_id) REFERENCES routes(id,transport_line_id) NOT VALID;
-- Existing cross-line history remains readable for review; all new writes are checked.

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='et_line_runtime') THEN
    CREATE ROLE et_line_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='et_line_runtime' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'et_line_runtime must be a restricted NOLOGIN/NOBYPASSRLS role';
  END IF;
END $$;
GRANT et_line_runtime TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO et_line_runtime;
GRANT SELECT ON admins,admin_line_memberships,driver_line_memberships TO et_line_runtime;
REVOKE SELECT ON admins FROM et_line_runtime;
GRANT SELECT(id,email,display_name,status,token_version,created_at,updated_at,is_superadmin) ON admins TO et_line_runtime;
GRANT SELECT(id,correo,nombre_usuario) ON conductores TO et_line_runtime;
GRANT SELECT ON transport_lines TO et_line_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON routes,route_variants,stops,fleet_vehicles,fleet_assignment_history TO et_line_runtime;
GRANT SELECT ON driver_sessions,physical_stops,route_legacy_aliases,variant_legacy_aliases,line_audit_log TO et_line_runtime;

CREATE FUNCTION et_can_access_line(target UUID, writing BOOLEAN DEFAULT FALSE) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT target IS NOT NULL
    AND target::text = current_setting('app.line_id',true)
    AND EXISTS(SELECT 1 FROM public.transport_lines WHERE id=target AND active)
    AND EXISTS(SELECT 1 FROM public.admins a WHERE a.id::text=current_setting('app.admin_id',true)
      AND a.status='active' AND a.token_version::text=current_setting('app.token_version',true)
      AND (a.is_superadmin OR EXISTS(SELECT 1 FROM public.admin_line_memberships m
        WHERE m.admin_id=a.id AND m.line_id=target AND m.active
        AND (NOT writing OR m.role IN ('admin','operator')))))
$$;
REVOKE ALL ON FUNCTION et_can_access_line(UUID,BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION et_can_access_line(UUID,BOOLEAN) TO et_line_runtime;

ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY routes_line_read ON routes FOR SELECT TO et_line_runtime USING(et_can_access_line(transport_line_id));
CREATE POLICY routes_line_write ON routes FOR ALL TO et_line_runtime USING(et_can_access_line(transport_line_id,true)) WITH CHECK(et_can_access_line(transport_line_id,true));
ALTER TABLE fleet_vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY fleet_line_read ON fleet_vehicles FOR SELECT TO et_line_runtime USING(et_can_access_line(transport_line_id));
CREATE POLICY fleet_line_write ON fleet_vehicles FOR ALL TO et_line_runtime USING(et_can_access_line(transport_line_id,true)) WITH CHECK(et_can_access_line(transport_line_id,true));
ALTER TABLE route_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY variants_line_read ON route_variants FOR SELECT TO et_line_runtime USING(EXISTS(SELECT 1 FROM routes r WHERE r.id=route_id));
CREATE POLICY variants_line_write ON route_variants FOR ALL TO et_line_runtime USING(EXISTS(SELECT 1 FROM routes r WHERE r.id=route_id AND et_can_access_line(r.transport_line_id,true))) WITH CHECK(EXISTS(SELECT 1 FROM routes r WHERE r.id=route_id AND et_can_access_line(r.transport_line_id,true)));
ALTER TABLE stops ENABLE ROW LEVEL SECURITY;
CREATE POLICY stops_line_read ON stops FOR SELECT TO et_line_runtime USING(EXISTS(SELECT 1 FROM routes r WHERE r.id=route_id));
CREATE POLICY stops_line_write ON stops FOR ALL TO et_line_runtime USING(EXISTS(SELECT 1 FROM routes r WHERE r.id=route_id AND et_can_access_line(r.transport_line_id,true))) WITH CHECK(EXISTS(SELECT 1 FROM routes r WHERE r.id=route_id AND et_can_access_line(r.transport_line_id,true)));
ALTER TABLE conductores ENABLE ROW LEVEL SECURITY;
CREATE POLICY conductores_line_read ON conductores FOR SELECT TO et_line_runtime USING(EXISTS(SELECT 1 FROM driver_line_memberships m WHERE m.conductor_id=id AND m.active AND et_can_access_line(m.line_id)));
ALTER TABLE driver_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_line_read ON driver_sessions FOR SELECT TO et_line_runtime USING(et_can_access_line(transport_line_id));
ALTER TABLE fleet_assignment_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY assignments_line_read ON fleet_assignment_history FOR SELECT TO et_line_runtime USING(EXISTS(SELECT 1 FROM fleet_vehicles v WHERE v.id=vehicle_id));
CREATE POLICY assignments_line_insert ON fleet_assignment_history FOR INSERT TO et_line_runtime WITH CHECK(EXISTS(SELECT 1 FROM fleet_vehicles v WHERE v.id=vehicle_id AND et_can_access_line(v.transport_line_id,true)) AND admin_id::text=current_setting('app.admin_id',true));
ALTER TABLE line_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_line_read ON line_audit_log FOR SELECT TO et_line_runtime USING(et_can_access_line(line_id));
ALTER TABLE transport_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY lines_read ON transport_lines FOR SELECT TO et_line_runtime USING(et_can_access_line(id));

CREATE FUNCTION et_audit_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE entry jsonb; tenant uuid; actor uuid;
BEGIN
  entry := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  actor := NULLIF(current_setting('app.admin_id',true),'')::uuid;
  IF actor IS NOT NULL THEN
    tenant := NULLIF(current_setting('app.line_id',true),'')::uuid;
    INSERT INTO public.line_audit_log(line_id,actor_id,action,entity_type,entity_id)
      VALUES(tenant,actor,TG_OP,TG_TABLE_NAME,entry->>'id');
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
REVOKE ALL ON FUNCTION et_audit_mutation() FROM PUBLIC;
CREATE TRIGGER audit_routes AFTER INSERT OR UPDATE OR DELETE ON routes FOR EACH ROW EXECUTE FUNCTION et_audit_mutation();
CREATE TRIGGER audit_fleet AFTER INSERT OR UPDATE OR DELETE ON fleet_vehicles FOR EACH ROW EXECUTE FUNCTION et_audit_mutation();
CREATE TRIGGER audit_variants AFTER INSERT OR UPDATE OR DELETE ON route_variants FOR EACH ROW EXECUTE FUNCTION et_audit_mutation();
CREATE TRIGGER audit_stops AFTER INSERT OR UPDATE OR DELETE ON stops FOR EACH ROW EXECUTE FUNCTION et_audit_mutation();
ALTER TABLE routes ALTER COLUMN transport_line_id SET DEFAULT NULLIF(current_setting('app.line_id',true),'')::uuid;
ALTER TABLE fleet_vehicles ALTER COLUMN transport_line_id SET DEFAULT NULLIF(current_setting('app.line_id',true),'')::uuid;
GRANT SELECT(stop_id) ON favorite_stops TO et_line_runtime;
ALTER TABLE alerts ADD COLUMN transport_line_id UUID REFERENCES transport_lines(id) DEFAULT NULLIF(current_setting('app.line_id',true),'')::uuid;
UPDATE alerts a SET transport_line_id=r.transport_line_id FROM routes r WHERE a.route_id=r.id;
ALTER TABLE alerts ADD CONSTRAINT alerts_route_line_fk FOREIGN KEY(route_id,transport_line_id) REFERENCES routes(id,transport_line_id);
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_line_read ON alerts FOR SELECT TO et_line_runtime USING(et_can_access_line(transport_line_id));
CREATE POLICY alerts_line_write ON alerts FOR ALL TO et_line_runtime USING(et_can_access_line(transport_line_id,true)) WITH CHECK(et_can_access_line(transport_line_id,true));
GRANT SELECT,INSERT,UPDATE ON alerts TO et_line_runtime;
CREATE TRIGGER audit_alerts AFTER INSERT OR UPDATE OR DELETE ON alerts FOR EACH ROW EXECUTE FUNCTION et_audit_mutation();
ALTER TABLE user_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY reports_line_read ON user_reports FOR SELECT TO et_line_runtime USING(EXISTS(SELECT 1 FROM routes r WHERE r.id=route_id));
GRANT SELECT(id,type,route_id,variant_id,bus_id,message,severity,status,created_at) ON user_reports TO et_line_runtime;
COMMIT;
