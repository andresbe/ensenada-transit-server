# GPS tracking schema (Android and hardware trackers)

Base migrations `029_tracking_devices.sql` and `030_vehicle_gps_locations.sql`, extended
by `031_teltonika_ingestion.sql` and `032_ruptela_ingestion.sql`. Additive only.

| Table | Purpose |
|---|---|
| `tracking_devices` | One row per tracker (unique `imei`). |
| `vehicle_device_assignments` | One row per installation period (`assigned_at`..`unassigned_at`). |
| `vehicle_gps_locations` | Append-only positions, `source` = `ANDROID`, `TELTONIKA` or `RUPTELA`. |
| `fleet_vehicles.is_test_vehicle` | Marks test vehicles (default `false`). |

## Reassigning a tracker
In one transaction: `UPDATE vehicle_device_assignments SET unassigned_at=now() WHERE device_id=$1 AND unassigned_at IS NULL`,
then `INSERT` the new row. Close both rows first when swapping two trackers. Nothing is deleted; foreign keys are
`ON DELETE RESTRICT`, so a device or vehicle with history cannot be removed. Locations keep the `vehicle_id` they were
recorded with, so history stays correct after a move.

## Deduplication
Unique key is `(device_id, recorded_at, event_key)` for devices and `(vehicle_id, recorded_at)` for Android.
Hardware trackers can emit several distinct records with the same timestamp, so each adapter
sets `event_key` to a hash of the exact protocol record. Re-sent identical records collide and are ignored with
`INSERT ... ON CONFLICT DO NOTHING`. Leaving `event_key` empty falls back to one row per device per timestamp.

## Retention (not implemented, nothing is deleted automatically)
Volume: one point per 30-60 s is 1,440-2,880 rows per device per day (about 0.5-1M per device per year).
Proposal for later, to be decided before enabling:
- Keep full-resolution rows 90 days; keep older rows only if needed for reports (downsample to 1 per 5 min) or export to cold storage first.
- Delete in batches by `recorded_at` (e.g. `DELETE ... WHERE id IN (SELECT id ... WHERE recorded_at < $1 LIMIT 10000)`), run from a scheduled job, never in a migration. The BRIN index on `recorded_at` supports this.
- If volume grows, convert to monthly partitions by `recorded_at` and drop whole partitions (needs a new migration; the identity PK and unique indexes would need `recorded_at` in the key).
- Take a backup and review row counts before the first deletion; keep invalid points (`is_valid=false`) for a shorter period.

## Public visibility and the ingestion extension
029/030 alone do not enforce test-vehicle privacy on Redis-backed endpoints. The shared hardware integration checks
`is_test_vehicle` in `src/tracking/publicBuses.ts`, which feeds public live, ETA, journey-planning and line-statistics
responses. The check covers Teltonika, Ruptela and Android, including legacy sessions without `vehicle_id`. Authorized
internal dashboards retain access. Deploy that API revision before enabling the receiver; the SQL view alone is not enough.
The API-only `PUBLIC_TEST_VEHICLE_IDS` allowlist provides an explicit, disabled-by-default exception for exact hardware
test tracking IDs during public map testing. Database flags and the SQL public view stay unchanged; see
[the temporary test and disable procedure](TELTONIKA.md#temporary-public-map-test).

Additive `031_teltonika_ingestion.sql` extends these same tables with configuration revisions, assignment variants,
raw AVL JSON and durable delivery state. Existing location rows default to `skipped` and are never automatically replayed.
`tracking_device_rejections` contains only decoded protocol values that cannot satisfy the original typed location constraints;
it is not another vehicle registry or valid-location history. See [TELTONIKA.md](TELTONIKA.md) for ingestion and deployment.

Additive `032_ruptela_ingestion.sql` extends the existing source checks to `RUPTELA` and adds bounded, protected
packet diagnostics. It does not recreate the registry, assignments or history. See [RUPTELA.md](RUPTELA.md).

## Migration safety
Runner: `scripts/migration-runner.js`. It takes an advisory lock, records `name` and a SHA-256 checksum in
`schema_migrations`, skips applied files, fails if an applied file changed, and runs each file in a transaction.
Both migrations set `lock_timeout = 5s` and add only a metadata-only column (`DEFAULT false`) to `fleet_vehicles`.
Never edit an applied migration; add a new numbered migration.
