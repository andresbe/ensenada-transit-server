-- Validated constraints: abort atomically if legacy data needs correction.
-- Never silently delete, reassign, or normalize existing records.
ALTER TABLE route_variants ADD CONSTRAINT route_variants_id_route_unique UNIQUE (id, route_id);
ALTER TABLE stops ADD CONSTRAINT stops_variant_route_fk
  FOREIGN KEY (variant_id, route_id) REFERENCES route_variants(id, route_id) ON DELETE CASCADE;
ALTER TABLE saved_journeys ADD CONSTRAINT saved_journeys_variant_route_fk
  FOREIGN KEY (variant_id, route_id) REFERENCES route_variants(id, route_id) ON DELETE CASCADE;
ALTER TABLE passenger_trips ADD CONSTRAINT passenger_trips_variant_route_fk
  FOREIGN KEY (variant_id, route_id) REFERENCES route_variants(id, route_id);
-- Nullable historical references retain the existing SET NULL deletion policy.
ALTER TABLE user_reports ADD CONSTRAINT user_reports_variant_route_fk
  FOREIGN KEY (variant_id, route_id) REFERENCES route_variants(id, route_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE driver_sessions ADD CONSTRAINT driver_sessions_variant_route_fk
  FOREIGN KEY (variant_id, route_id) REFERENCES route_variants(id, route_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','driver','admin'));
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active','suspended','deleted'));
ALTER TABLE users ADD CONSTRAINT users_provider_check CHECK (auth_provider IN ('email','google','apple','guest'));
ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_language_check CHECK (language IN ('es','en'));
ALTER TABLE route_variants ADD CONSTRAINT route_variants_direction_check CHECK (direction IN ('ida','vuelta'));
ALTER TABLE route_variants ADD CONSTRAINT route_variants_distance_check
  CHECK (total_distance_meters >= 0 AND total_distance_meters <> 'NaN'::numeric);
ALTER TABLE stops ADD CONSTRAINT stops_coordinates_check
  CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);
ALTER TABLE stops ADD CONSTRAINT stops_sequence_check CHECK (sequence >= 0);
ALTER TABLE routes ADD CONSTRAINT routes_service_days_check
  CHECK (service_days <@ ARRAY[0,1,2,3,4,5,6] AND array_position(service_days,NULL) IS NULL);
ALTER TABLE routes ADD CONSTRAINT routes_cycle_check CHECK (estimated_cycle_minutes > 0);
ALTER TABLE user_reports ADD CONSTRAINT user_reports_coordinates_check CHECK (
  (latitude IS NULL AND longitude IS NULL) OR
  (latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
);
ALTER TABLE user_reports ADD CONSTRAINT user_reports_severity_check CHECK (severity IN ('low','moderate','high'));
ALTER TABLE user_reports ADD CONSTRAINT user_reports_type_check CHECK (type IN ('crowded','breakdown','delay','other','stopIssue','detour'));
ALTER TABLE passenger_trips ADD CONSTRAINT passenger_trips_dates_check CHECK (
  (status = 'active' AND ended_at IS NULL) OR
  (status IN ('completed','cancelled') AND ended_at IS NOT NULL AND ended_at >= started_at)
);
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_attempts_check CHECK (attempts >= 0);

-- PostgreSQL does not automatically index the referencing side of a foreign key.
CREATE INDEX stops_physical_stop_idx ON stops(physical_stop_id) WHERE physical_stop_id IS NOT NULL;
CREATE INDEX routes_transport_line_idx ON routes(transport_line_id) WHERE transport_line_id IS NOT NULL;
CREATE INDEX saved_journeys_variant_route_idx ON saved_journeys(variant_id,route_id);
CREATE INDEX saved_journeys_route_idx ON saved_journeys(route_id);
CREATE INDEX passenger_trips_variant_route_idx ON passenger_trips(variant_id,route_id);
CREATE INDEX passenger_trips_route_idx ON passenger_trips(route_id);
CREATE INDEX user_reports_variant_route_idx ON user_reports(variant_id,route_id);
CREATE INDEX driver_sessions_variant_route_idx ON driver_sessions(variant_id,route_id);
CREATE INDEX favorite_routes_route_idx ON favorite_routes(route_id);
CREATE INDEX favorite_stops_stop_idx ON favorite_stops(stop_id);
CREATE INDEX notification_subscriptions_route_idx ON notification_subscriptions(route_id);
CREATE INDEX notification_deliveries_alert_idx ON notification_deliveries(alert_id);
CREATE INDEX guest_account_transfers_account_idx ON guest_account_transfers(account_id);
