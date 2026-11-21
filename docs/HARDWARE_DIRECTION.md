# Automatic hardware direction detection

## Safety boundary

Teltonika and Ruptela keep their configured `vehicle_device_assignments.route_variant_id`.
The detector never rewrites an assignment, route geometry, GPS history, or Redis directly.
Production defaults to `HARDWARE_AUTO_DIRECTION_MODE=off`.

Migration `033_device_direction_state.sql` adds only `device_direction_state`. Migrations
029 through 032 are unchanged. The receiver processes do not run migrations. In `enabled`,
startup requires migration 033. In `shadow`, a failed schema check disables the detector
for that process and the hardware listener continues with the assigned variant.

## Data flow

```text
normalized fresh GPS row
  -> lock hardware device / load current assignment
  -> load the route's single ida/vuelta geometry pair
  -> restore per-device detector state
  -> compare movement against both variants
  -> persist evidence in the PostgreSQL outbox transaction
  -> choose assigned or confirmed effective variant according to mode
  -> existing ingestLocation -> route progress / ETA -> Redis -> live APIs
```

The three variant identities are deliberately separate:

- `assignedRouteVariantId`: administrator-controlled authorization and fallback.
- `detectedRouteVariantId`: last direction confirmed from GPS movement.
- `routeVariantId`: effective variant published to the existing pipeline. It remains the
  assigned variant in `off` and `shadow`; in `enabled` it becomes the confirmed detected
  variant and falls back to assigned when evidence is insufficient.

In enabled mode, `assignedRouteVariantId` is an additive live field. Public and admin
filters validate the hardware/vehicle relationship through this assigned variant and
then require the effective variant to belong to the same route. Existing fields retain
their meanings: `routeVariantId` and `routeVariantDirection` describe the effective trip.

## State machine

Each device has independent state. A moving observation is projected onto both route
geometries. Evidence combines:

- progress increasing in the geometry's coordinate order;
- displacement-derived bearing versus the nearest route segment;
- distance from the geometry and progress/displacement plausibility;
- terminal proximity;
- elapsed time, physical displacement and reported speed;
- device heading only as a supplemental score;
- satellite count when available.

Duplicate and delayed timestamps never mutate evidence. Stationary fixes do not move the
motion anchor, so slow movement can accumulate without allowing GPS drift to vote. Large
jumps, poor fixes and off-route points cannot confirm a switch. A gap over ten minutes
clears candidate evidence and establishes a new motion baseline while retaining a valid
last confirmed direction.

Initial direction requires three moving evidence intervals and at least 60 m. A terminal
turnaround requires three intervals and 60 m, with the old variant near its end and the
candidate near its start. A non-terminal reversal is deliberately slower: five intervals,
300 m, 90 seconds and at least three strong geometric observations. This hysteresis avoids
switching for one closer point or a short U-turn. Thresholds do not depend on an exact
sample period and support 10-30 second Teltonika and approximately 60 second Ruptela data.

Assignment changes or any route geometry fingerprint change reset detected and candidate
evidence. A normal backend restart restores state from PostgreSQL.

## Modes and configuration

```dotenv
HARDWARE_AUTO_DIRECTION_MODE=off
```

| Mode | Detector state | Redis/API/ETA behavior |
|---|---|---|
| `off` | Not loaded or written | Exactly the existing assigned variant behavior |
| `shadow` | Calculated, persisted and logged | Assigned variant remains effective |
| `enabled` | Calculated, persisted and logged | Confirmed variant becomes effective |

`off` does not load route pairs, query `device_direction_state`, or write detector state,
and therefore does not require migration 033. Shadow database work is isolated with
savepoints, a 500 ms lock timeout, and a 1.5 second statement timeout. A load, evaluation,
or persistence failure emits `shadow_disabled`, disables shadow processing in that receiver
until restart, and commits normal GPS delivery using the assigned variant. A database or
connection failure that prevents savepoint recovery still follows the existing durable
outbox retry path because the surrounding transaction is no longer usable.

Optional tuning variables are listed in `.env.example`. Defaults should be changed only
after replay and shadow logs demonstrate a route-specific need. Both hardware receiver
services must use the same mode and tuning values because either service can update the
shared state for its own devices. The HTTP API can remain `off`; it reads the additive
Redis field and does not run detection itself.

| Threshold | Default |
|---|---:|
| Minimum displacement / progress | 15 m / 10 m |
| Maximum route distance / strong route distance | 100 m / 45 m |
| Route-distance advantage | 30 m |
| Maximum bearing error | 70 degrees |
| Maximum physical jump speed / Ruptela HDOP | 45 m/s / 5 |
| Signal-gap rebaseline | 600 s |
| Stationary speed / drift allowance | 0.7 m/s / 45 m |
| Initial confirmation | 3 intervals, 60 m, 20 s |
| Terminal switch | 3 intervals, 60 m, 20 s, within 200 m of terminals |
| Non-terminal switch | 5 intervals, 300 m, 90 s, 3 strong intervals |
| Candidate evidence gap | 300 s |

Invalid values or incoherent combinations fail receiver readiness in `enabled`, disable
the detector with an explicit startup event in `shadow`, and are ignored in `off` to
preserve the legacy startup path.

Structured events use `service=hardware-direction` and include provider, device, assigned,
candidate, detected and effective variants, confidence, reason and rounded displacement.
They intentionally omit exact GPS coordinates.

## Read-only historical replay

Build and replay one device at a time:

```sh
npm run replay:hardware-direction -- \
  --device-id DEVICE_UUID \
  --from 2026-11-20T14:00:00-08:00 \
  --to 2026-11-20T23:00:00-08:00
```

Use a database role that has only `CONNECT`, `USAGE`, and `SELECT`, and add PostgreSQL's
read-only session setting as a second guard:

```sh
export DATABASE_URL='postgresql://hardware_replay_ro:REDACTED@HOST:PORT/railway'
export DATABASE_SSL_MODE='verify-full'
export PGOPTIONS='-c default_transaction_read_only=on'
npm run build
node scripts/replay-hardware-direction.js \
  --device-id DEVICE_UUID \
  --from 2026-11-20T14:00:00-08:00 \
  --to 2026-11-20T23:00:00-08:00 \
  --limit 50000 > /tmp/hardware-direction-replay.jsonl
unset DATABASE_URL DATABASE_SSL_MODE PGOPTIONS
```

The command opens `BEGIN TRANSACTION READ ONLY`, reads valid Teltonika/Ruptela rows in
timestamp order, rolls the transaction back, and evaluates in memory. It never imports
the Redis client or writes detector state. JSON Lines include timestamp, position,
assignment, candidate, detected variant, ida/vuelta progress, confidence and decision
reason. The summary is written to stderr.

Replay uses the current route geometry because GPS history does not version geometry.
That limitation must be considered when evaluating old records. No production replay was
run as part of this implementation. Do not claim turnaround accuracy for Gomez Morin
until a read-only replay contains a complete moving ida/terminal/vuelta sequence.

## Rollout

1. Obtain deployment approval separately from PR approval. Record the previous healthy
   deployment ID, start command and mode of each service. Check branch triggers, PR
   environments and pre-deploy hooks. Stop if the release would automatically run
   `npm run migrate` or enable the detector; OFF does not disable an external migration job.
2. Roll the services below one at a time on the same revision, validating each before the
   next. Keep `HARDWARE_AUTO_DIRECTION_MODE=off` (unset also defaults to OFF).
   Do not apply 033, change TCP proxies, or redeploy PostgreSQL or Redis.
3. Only in a later, separately approved window, apply 033 via the migration owner.
4. After all instances are current, enable `shadow` on an approved receiver and inspect decisions/state.
5. Run read-only replays for complete real trips, starting with Gomez Morin.
6. Tune only with recorded evidence and repeat shadow observation.
7. Enable only after explicit approval. The flag is per receiver process, not per device.

| Railway service | Existing start command | Check |
|---|---|---|
| `ensenada-transit-server` (HTTP API) | `npm start` | Existing HTTP port, `/health` |
| `teltonika-ingestion` | `node dist/teltonika/server.js` | TCP target 5027, HTTP 8080 `/ready` |
| `ruptela-ingestion` | `node dist/ruptela/server.js` | TCP target 5028, HTTP 8080 `/ready` |

### Production validation (read only, after approval)

Run these before and after each service update, from a trusted workstation or the
private network. Set the URL variables to the existing **HTTP** origins, not the raw TCP
proxies. Supply existing metrics tokens from the secret store; do not create a public
listener or enable metrics for this release. An empty public bus list is legitimate.

```sh
curl -fsS "$API_URL/health"
curl -fsS "$API_URL/buses/live" | jq -e '.buses | type == "array"'
curl -fsS "$API_URL/routes/06964079-f945-4cd8-a7f2-9e2c9bb21c27/live" | jq -e '.buses | type == "array"'
curl -fsS "$TELTONIKA_HTTP_URL/ready"
curl -fsS "$RUPTELA_HTTP_URL/ready"
curl -fsS -H "Authorization: Bearer $TELTONIKA_METRICS_TOKEN" "$TELTONIKA_HTTP_URL/metrics" | jq '{redisReady,published,failures,outbox}'
curl -fsS -H "Authorization: Bearer $RUPTELA_METRICS_TOKEN" "$RUPTELA_HTTP_URL/metrics" | jq '{redisReady,published,failures,outbox}'
```

Allow several reporting intervals with an active unit. Check for fresh published timestamps
for each active provider, Redis readiness, stable failure counters and a draining outbox.
If metrics are disabled, use receiver logs plus the following SQL through an approved
read-only connection (no IMEI or coordinates needed):

```sql
BEGIN READ ONLY;
SELECT source, max(recorded_at) AS latest_fix,
       max(delivered_at) FILTER (WHERE delivery_status='published') AS latest_publication,
       count(*) FILTER (WHERE delivery_status='pending') AS recent_pending
FROM vehicle_gps_locations
WHERE recorded_at >= now() - interval '15 minutes' AND source IN ('TELTONIKA','RUPTELA')
GROUP BY source;
SELECT to_regclass('public.device_direction_state') AS direction_table;
ROLLBACK;
```

For the initial OFF release the table should remain absent if absent at baseline. With
normal traffic, compare visible units and assigned variants before/after, and confirm
there are no `direction_evaluated` events. No traffic means delivery is unverified,
not that a successful readiness check proved GPS publication.

Code can roll while the mode is `off`, before or after migration 033, because old services
ignore the additive table and new services do not access it in `off`. Shadow is also
passenger-compatible during a mixed rollout, but observations handled by old receivers do
not contribute detector evidence. Do not roll `enabled` across mixed old/new API or receiver
instances: old receivers can republish the assigned direction and old APIs reject an
effective variant that differs from the assignment.

**Rollback:** Stop the roll on a failing readiness check, missing live fixes despite
active traffic, growing backlog or unexpected public direction changes. Restore the
previous healthy deployment(s) listed in step 1, most recently updated first, keeping
OFF, and repeat the checks above. No SQL rollback, Redis flush, proxy or device changes
are needed. If reverting a *later enabled* release, switch all writers to OFF first
and wait for effective-direction samples to be replaced or expire before restoring old
API readers. Leave 033 in place.

## Known risks

- Parallel or overlapping road geometry can delay a decision; ambiguity intentionally
  favors the last confirmed or assigned variant.
- Long mid-route detours or reversals may eventually satisfy geometric hysteresis.
- Bad geometry ordering produces bad progress evidence; the detector does not repair it.
- Current geometry replay cannot reproduce a historical geometry revision exactly.
- Shadow/enabled adds two small indexed reads and one upsert per active device batch,
  plus projection cost proportional to both polylines.
- Direction changes reset in-memory ETA history to the effective variant, so ETA confidence
  rebuilds over subsequent points instead of mixing opposite-direction progress.
