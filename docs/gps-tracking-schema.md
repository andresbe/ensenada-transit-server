# GPS tracking schema (Teltonika FTC927)

Migrations `029_tracking_devices.sql` and `030_vehicle_gps_locations.sql`. Additive only.

| Table | Purpose |
|---|---|
| `tracking_devices` | One row per tracker (unique `imei`). |
| `vehicle_device_assignments` | One row per installation period (`assigned_at`..`unassigned_at`). |
| `vehicle_gps_locations` | Append-only positions, `source` = `ANDROID` or `TELTONIKA`. |
| `fleet_vehicles.is_test_vehicle` | Marks test vehicles (default `false`). |

## Reassigning a tracker
In one transaction: `UPDATE vehicle_device_assignments SET unassigned_at=now() WHERE device_id=$1 AND unassigned_at IS NULL`,
then `INSERT` the new row. Close both rows first when swapping two trackers. Nothing is deleted; foreign keys are
`ON DELETE RESTRICT`, so a device or vehicle with history cannot be removed. Locations keep the `vehicle_id` they were
recorded with, so history stays correct after a move.

## Deduplication
Unique key is `(device_id, recorded_at, event_key)` for devices and `(vehicle_id, recorded_at)` for Android.
Teltonika can emit several distinct records with the same timestamp (event plus periodic record), so the ingester
should set `event_key` (event IO id or a hash of the raw record). Re-sent identical records collide and are ignored with
`INSERT ... ON CONFLICT DO NOTHING`. Leaving `event_key` empty falls back to one row per device per timestamp.

## Retention (not implemented, nothing is deleted automatically)
Volume: one point per 30-60 s is 1,440-2,880 rows per device per day (about 0.5-1M per device per year).
Proposal for later, to be decided before enabling:
- Keep full-resolution rows 90 days; keep older rows only if needed for reports (downsample to 1 per 5 min) or export to cold storage first.
- Delete in batches by `recorded_at` (e.g. `DELETE ... WHERE id IN (SELECT id ... WHERE recorded_at < $1 LIMIT 10000)`), run from a scheduled job, never in a migration. The BRIN index on `recorded_at` supports this.
- If volume grows, convert to monthly partitions by `recorded_at` and drop whole partitions (needs a new migration; the identity PK and unique indexes would need `recorded_at` in the key).
- Take a backup and review row counts before the first deletion; keep invalid points (`is_valid=false`) for a shorter period.

## `is_test_vehicle` is not enforced anywhere yet
The column and the view `public_vehicle_gps_locations` exist, but no endpoint uses them. Today's public bus list
(`src/tracking/publicBuses.ts`) reads live positions from Redis and does not check `is_test_vehicle`. The view protects
nothing by itself. Before test vehicles are used in production, public endpoints (live buses, nearby buses, any history
read) must filter `NOT is_test_vehicle` or read from the view. Admin endpoints should still see them.

## Migration safety
Runner: `scripts/migration-runner.js`. It takes an advisory lock, records `name` and a SHA-256 checksum in
`schema_migrations`, skips applied files, fails if an applied file changed, and runs each file in a transaction.
Both migrations set `lock_timeout = 5s` and add only a metadata-only column (`DEFAULT false`) to `fleet_vehicles`.
Never edit 029/030 after they are applied; add 031+.
