-- Preserve legacy favorites without duplicating routes already saved by the new API.
-- Existing accounts above the quota retain their data, but cannot add more until below it.
INSERT INTO saved_journeys(user_id,route_id,client_id,created_at)
SELECT f.user_id,f.route_id,'legacy-route:'||f.route_id::text,f.created_at FROM favorite_routes f
-- Rows predating 008 were already copied. Do not resurrect favorites removed in the new API.
WHERE f.created_at > (SELECT applied_at FROM schema_migrations WHERE name='008_passenger_platform.sql')
AND NOT EXISTS(SELECT 1 FROM saved_journeys j WHERE j.user_id=f.user_id AND j.route_id=f.route_id)
ON CONFLICT(user_id,client_id) DO NOTHING;
