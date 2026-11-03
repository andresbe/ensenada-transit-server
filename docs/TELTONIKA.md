# Teltonika FTC927 integration

## Readiness and accepted limitation

**Ready for a controlled private pilot**, with the following TODO (P2) explicitly
accepted and deferred. This is not approval for a general passenger rollout, merge,
deployment or production migration; those actions still require release authorization.
The protocol, persistence, compatibility and visibility verification results are preserved
in [the implementation report](TELTONIKA_IMPLEMENTATION.md#verification).

Private visibility remains the default. The separate
[temporary public map test](#temporary-public-map-test) is an explicit opt-in exception;
enabling it makes the allowlisted unit's location accessible without authentication.

### TODO (P2): passenger boarding isolation

The existing boarding service does not check `fleet_vehicles.is_test_vehicle` when
validating a normal passenger's boarding. A test vehicle can still receive normal
passenger boardings through `POST /locations/update` (`sourceType=user`) when an active
Android driver session exists and the passenger/location/session checks otherwise pass.
These are real boarding records (`is_test=false`), not tester-mode records. The same
missing vehicle check affects creation and renewal; the service reads the bus's Redis
location directly instead of using the public visibility filter.

This pre-existing behavior was reproduced on both the integration branch and clean
`origin/main`. It is deliberately unchanged for the initial FTC927 pilot. Public
discovery/live, route, ETA, journey-planning and statistics visibility protections remain
in place, including Redis-backed queries; hiding a vehicle does not itself prevent a
direct boarding request.

Pilot safeguards: keep `is_test_vehicle=true` and device `public_visible=false`, do not
start an Android driver session on the pilot unit, and do not use it for real passenger
boarding tests. These are operational restrictions, not a new server-side boarding guard.
Keep `PUBLIC_TEST_VEHICLE_IDS` unset except during the explicitly authorized public map test.
Before broader passenger rollout, reject test vehicles in normal boarding creation and
renewal and add regression tests for an active Android session with valid Redis evidence.
No boarding functionality or migration was changed to document this deferral.

## Architecture and compatibility

The existing Express API keeps its start command and Android contract. A separate
Node TCP process runs from the same repository, using the same PostgreSQL and Redis.
No API-to-API calls, internal HTTP secrets, extra database, or mobile changes are required.

```text
FTC927 -> Railway TCP Proxy -> TCP receiver -> Codec 8E -> PostgreSQL telemetry/outbox
                                                             |
                                                        outbox worker
                                                             |
Android POST /locations/update -> shared ingestLocation -> route geometry/speed/direction/ETA
                                                             |
                                                           Redis
                                                             |
                                                existing API / passenger endpoints
```

Production migrations `029_tracking_devices.sql` and `030_vehicle_gps_locations.sql`
are reused byte-for-byte. `vehicle_device_assignments` links devices to the existing
`fleet_vehicles` registry and preserves closed installation periods. Existing `tracking_id`
remains the public `busId`; there is no second vehicle registry. An installation has an
optional explicit route variant. It must belong to the vehicle's line and, when set, its assigned
route. Existing route matching and direction-confidence calculations are reused.
The tracker's configured variant is not automatically switched at a terminus; an
administrator must update it. Android session/checkpoint direction detection is unchanged.

The shared pipeline tags Android internally as `ANDROID`; the HTTP validator discards
client-supplied provider/device identity. Teltonika is normalized as `TELTONIKA`.
Android retains its existing JWT/session validation, response, rate limit, and Redis
failure/retry semantics. `LOCATION_UPDATE_AUTH_MODE` is not changed by this integration.
This does not add a SQL history write to each Android HTTP update; its existing Redis/session
storage path is preserved. The shared GPS table still supports `source=ANDROID` writers and
existing Android rows, with no backfill or contract change.

## Protocol and delivery

- Length-prefixed 15-digit IMEI handshake; registered TELTONIKA devices with `status=active` receive `01`,
  rejected handshakes receive `00`. IMEI is an identifier, not a cryptographic credential.
- Codec `0x8E` only: signed longitude/latitude divided by 10,000,000, signed altitude,
  GPS speed converted from km/h to m/s, event IDs, 1/2/4/8-byte IO and NX variable IO.
  IO values stay hexadecimal so 64-bit values never lose precision in JSON.
- CRC-16/IBM, preamble, record counts, IO counts and complete packet length are checked.
  Fragmented and coalesced frames are supported. Invalid/oversized frames close only
  that connection without an AVL acknowledgment.
- Every record in a packet is committed atomically before the four-byte count ACK.
  The outbox worker runs independently of the socket. A Redis outage cannot lose an
  acknowledged packet. A failed PostgreSQL commit gets no ACK; the device must retry.
- `vehicle_gps_locations` uses its existing unique `(device_id, recorded_at, event_key)`
  index, with `event_key = SHA-256(raw AVL record)` and `ON CONFLICT DO NOTHING`.
  This handles retransmission, including
  the same record repackaged into a different batch. Duplicates receive the full count
  ACK without adding history or refreshing live TTL. Distinct AVL contents at the same
  timestamp are retained as separate rows; only the first fresh fix at that timestamp
  can update the live location.
- `(0,0)`, zero satellites (including retained last-fix coordinates), out-of-range
  coordinates, invalid headings and future timestamps are retained as diagnostics,
  not live locations. Original timestamps, priority, event IDs and IO are retained.
  Invalid but representable fixes go into `vehicle_gps_locations` with `is_valid=false`.
  Coordinates outside bounds, speed >=100 m/s, heading >=360, satellites >99 or timestamps
  beyond year 9999 cannot fit the deployed typed schema. Only these records go into
  `tracking_device_rejections`, deduplicated by device/event hash, with the original JSON.
  No coordinates are clamped or invented. Both storage paths commit together before ACK.
- Old records remain history. Live publication uses the smaller of
  `TELTONIKA_MAX_LIVE_AGE_SECONDS` and `LOCATION_TTL_SECONDS`. Device watermarks and the
  atomic Redis timestamp comparison prevent older records from replacing newer fixes.
- Registry revision and installation ID are captured at ingestion. Historical vehicle
  attribution uses the installation period containing the recorded timestamp, not simply
  the currently installed vehicle. Unknown periods retain a null vehicle. Configuration
  and assignment triggers invalidate queued/cached data even after direct SQL updates.
  Data queued before reassignment or disabling cannot be published under a new assignment.
  Public reads recheck current device status, revision, assignment, route and test flag.
- An active Android driver session takes priority for the same vehicle. Tracker records
  are still stored, with `android_session_active` as the delivery reason.
- No operating-hour filter is applied. The pilot's 06:00-23:00 schedule is operational
  guidance only; future per-vehicle scheduling belongs outside telemetry acceptance.

`delivery_status=published` means the shared pipeline accepted publication; Redis may
already contain a newer fix. `skipped` means history-only and includes a reason. `pending`
means publication will be retried. Replaying after a crash is safe, but not an exactly-once
transaction spanning PostgreSQL and Redis.

## Local development

Use Node 22 or newer (existing Google auth dependencies also require it), PostgreSQL and
Redis. Use a disposable local database when testing migrations. The repository's
`npm run dev:local` tooling can provision the local infrastructure; see the main README.

```sh
npm ci
npm run type-check
npm run build
npm run migrate
# Terminal 1: existing HTTP API
PORT=3000 npm start
# Terminal 2: receiver (same DATABASE_URL and REDIS_URL)
PORT=8080 TELTONIKA_TCP_PORT=5027 npm run start:teltonika
```

The receiver binds both listeners to `0.0.0.0`. Do not use the same port for its TCP and
HTTP listeners. Its startup checks the operational schema through migration 031; it never
applies migrations. Set `PORT=8080` explicitly: the shared `.env.example` uses 3000 for the API.

## Registration and internal diagnostics

The existing API exposes the following platform-only endpoints. All require a valid
admin JWT belonging to an active **superadministrator**, with the existing token-version
checks. Line admins, drivers, passengers and anonymous requests are rejected.

| Endpoint | Behavior |
| --- | --- |
| `GET /admin/tracking-devices?limit=50&offset=0` | Paginated devices, IMEI suffix only |
| `POST /admin/tracking-devices` | Register an IMEI and optional fleet/variant assignment |
| `PATCH /admin/tracking-devices/:id` | Change configuration with current `revision` |
| `GET /admin/tracking-devices/:id/telemetry?limit=50&offset=0` | Exact diagnostic history, valid and invalid records, delivery reasons |
| `GET /admin/tracking-devices/:id/rejections?limit=50&offset=0` | Raw records that cannot fit the GPS table's typed constraints |
| `GET /admin/tracking-devices/:id/assignments?limit=50&offset=0` | Installation and route-variant history, never deleted on reassignment |

Example POST body, supplied through an authenticated HTTPS administrative client:

```json
{
  "imei": "<physical-device-15-digit-IMEI>",
  "model": "FTC927",
  "firmware_version": "3.0.7",
  "test_vehicle": true,
  "route_variant_id": "<existing-route-variant-UUID>"
}
```

`test_vehicle: true` creates `TEST-FTC927-001` in the existing fleet, marked
`is_test_vehicle=true`. It uses the variant's existing line and route. Omit the variant
to collect diagnostics before assignment; in that case first assign the vehicle to the
appropriate line using existing platform fleet tools, then PATCH the device's variant.
Creation fails on an existing pilot identifier; it never silently claims another unit.
For an existing test vehicle, use `vehicle_id` instead of `test_vehicle`.

By default, private device registrations do not appear in passenger live/ETA/search
responses. The existing platform/line dashboard live endpoint includes mapped trackers,
including private test units for authorized operators; line isolation is enforced by RLS
and column-level grants that exclude IMEI and raw history. A test vehicle remains excluded
from public discovery/live, route, ETA, journey-planning and statistics responses even if
someone starts an Android session on it. The explicit Teltonika-only public map allowlist
below is the sole temporary visibility exception. Boarding requests have the separate
[accepted TODO (P2)](#todo-p2-passenger-boarding-isolation) above. Its valid telemetry can
still run through the shared pipeline and be inspected via
the authenticated telemetry endpoint. The `telemetry` object includes its internal
vehicle ID, m/s speed, satellites, recorded/received times and GPS validity.

Register a real fleet unit with `vehicle_id`, `route_variant_id`, and explicitly
`public_visible: true` to publish it. Public output strips device/source identifiers.
PATCH requires the latest `revision` and accepts `model`, `firmware_version`, `status`,
`vehicle_id`, `route_variant_id`, `public_visible`; nullable fields accept `null`.
Status is `active`, `inactive` or `retired`; only `active` accepts telemetry. Model and
firmware are limited to 60 characters, matching production constraints. IMEI is immutable.
Device changes are recorded in `line_audit_log` without the IMEI. Changing vehicle or
variant closes the current assignment and creates a new one in the same transaction;
`assigned_by` records the admin. Unique active-device/vehicle indexes prevent double assignment.
To unassign, PATCH `vehicle_id: null`, `route_variant_id: null`, `public_visible: false`.

If Railway already registered the physical IMEI, GET the registry and PATCH that device
using its current `revision`; do not POST a duplicate. Existing installations from 029
remain in place after 031 but default to no variant and private visibility. Add the correct
variant using PATCH before expecting live route/ETA output. Inspect `/telemetry` and
`/rejections` even when no route has been assigned.

## Temporary public map test

To view `TEST-FTC927-001` in the existing passenger application, deploy the API change
only after approval and set this variable on **ensenada-transit-server**, not on the
`teltonika-ingestion` receiver:

```dotenv
PUBLIC_TEST_VEHICLE_IDS=TEST-FTC927-001
```

The allowlist is disabled when unset or empty. Values are exact, case-sensitive fleet
`tracking_id` values, comma-separated with surrounding whitespace ignored; there are no
wildcards or prefix matching. Only explicitly listed Teltonika vehicles that are still
marked `is_test_vehicle=true` can bypass the test flag and device `public_visible=false`
for public reads. Other test vehicles, private non-test devices and Android test sessions
remain hidden. Keep both PostgreSQL flags unchanged; no migration, Redis rewrite or
ingestion change is required.

This uses the shared public filter, so visibility is consistent in `/buses/live`,
`/routes/:routeId/live` (route ID or variant ID), and variant ETA responses. Journey
planning and line statistics also use that filter and can include the allowlisted unit.
Route matching, direction, freshness and ETA calculations are unchanged. Published/active
routes, active lines/devices, available vehicles, current assignment/revision matching
and Android-session priority are still required. Private device/source identifiers remain
stripped from public output. This is public exposure, not administrator-only access.

During this temporary test, verify `/buses/live` and
`/routes/06964079-f945-4cd8-a7f2-9e2c9bb21c27/live` return `TEST-FTC927-001` with the
expected variant, coordinates and timestamp. Keep the pilot GPS-only: no active Android
session or real passenger boarding tests, consistent with the accepted TODO (P2).

**Disable:** remove `PUBLIC_TEST_VEHICLE_IDS` (or set it empty) on the API service and
restart/redeploy all API replicas with the updated environment. New public requests will
hide the unit even if its position remains in Redis; no database cleanup is needed.
Confirm both public live endpoints exclude it while the authenticated administrative
live endpoint continues to show fresh data. Previously fetched client data may remain
visible until the passenger app refreshes. No deployment or production variable change
is performed automatically by this implementation.

## Simulator and tests

Register a synthetic IMEI in the **local** registry first, then:

```sh
npm run simulate:teltonika -- --imei <registered-test-IMEI> --fragment --records 3
npm run test:teltonika
node --test --test-concurrency=1 tests/*.test.js
# Optional real-Redis test, with an isolated localhost Redis instance:
TELTONIKA_TEST_REDIS_URL=redis://127.0.0.1:<test-port> node --test tests/teltonika-redis.test.js
```

Simulator default destination is `127.0.0.1:5027`. Non-loopback destinations require
both an explicit `--host` and `--allow-remote`. Do not target production without approval.
The generated positions are test data, not real-device evidence. Tests include Teltonika's
official 8E example, custom deterministic multi-record/NX fixtures, real loopback sockets,
and PostgreSQL-compatible PGlite migrations/queries. Existing infrastructure-dependent
tests retain their explicit local opt-in flags.

## Environment

| Variable | Default / purpose |
| --- | --- |
| `DATABASE_URL`, `REDIS_URL` | Required; same services as API, private Railway references |
| `DATABASE_SSL_MODE`, `DATABASE_SSL_CA` | Existing shared database SSL policy |
| `NODE_ENV` | `production` on Railway |
| `PORT` | Receiver health HTTP port, set `8080` on Railway |
| `TELTONIKA_TCP_PORT` | `5027`, internal raw TCP listener |
| `TELTONIKA_MAX_FRAME_BYTES` | `65536`, maximum data field, before framing allocation |
| `TELTONIKA_MAX_CONNECTIONS` | `600`, hard socket cap per process |
| `TELTONIKA_MAX_IN_FLIGHT` | `16`, concurrent storage operations; excess connections retry |
| `TELTONIKA_FRAMES_PER_MINUTE` | `120`, per device, survives same-process reconnection |
| `TELTONIKA_IDLE_TIMEOUT_SECONDS` | `180` |
| `TELTONIKA_FRAME_TIMEOUT_SECONDS` | `30`, handshake/frame completion deadline |
| `TELTONIKA_MAX_LIVE_AGE_SECONDS` | `240`, additionally bounded by API freshness TTL |
| `LOCATION_TTL_SECONDS` | Set identically on API/receiver; pilot recommendation `240` |
| `PUBLIC_TEST_VEHICLE_IDS` | API only, empty by default; exact Teltonika test tracking IDs temporarily exposed to public live/ETA/planning/statistics reads |
| `TELTONIKA_OUTBOX_POLL_MS` | `1000`, non-overlapping worker polling |
| `TELTONIKA_ALLOWED_PEERS` | Optional comma-separated direct-peer IPs/CIDRs |
| `TELTONIKA_METRICS_TOKEN` | Optional random bearer secret; empty disables `/metrics` |
| `RAILWAY_DOCKERFILE_PATH` | Receiver service only: `Dockerfile.teltonika` |

There is no full IMEI or coordinate logging in the TCP receiver/shared Teltonika path.
Access to detailed telemetry is deliberately limited. `/health` is process liveness;
`/ready` checks PostgreSQL and the TCP listener. Redis availability is exposed in protected
metrics, not readiness: the receiver can durably accept records while Redis recovers.

## Railway preparation (no deployment performed)

1. Obtain explicit release approval first. Readiness is limited to the controlled private
   pilot with the documented TODO (P2); no merge into `main`, deployment or production
   migration has been performed. Review the existing backup
   and `schema_migrations`. Production already has 029/030 according to the supplied Railway
   report; their contents/checksums are unchanged. Only `031_teltonika_ingestion.sql` is new.
   It adds operational fields, assignment variants/revision triggers, location outbox columns,
   rejected-record diagnostics and scoped read permissions. It never replays old locations.
   Verify this upgrade in staging first. Lock timeout is 5 seconds; index creation still
   needs a deployment window appropriate to the history table's size. Review earlier pending
   migrations separately if the target is not actually current through 030.
2. After explicit deployment approval, run migrations once in the existing backend's
   Railway environment of **ensenada-transit-server**, using its pre-deploy command
   `npm run migrate` or container shell and private DB URL. It remains the sole migration
   owner. Leave the receiver's pre-deploy command empty: never run `npm run migrate` from
   `teltonika-ingestion`. `railway run` runs locally and cannot
   normally resolve Railway private hostnames. Never paste credentials into docs/logs.
3. Deploy the API revision with the shared publication/visibility changes before enabling
   the receiver. Leave the existing API start command and HTTP domain in place.
4. Add a **separate service named `teltonika-ingestion` from `andresbe/ensenada-transit-server`**,
   in the same project/environment as the API, PostgreSQL and Redis, same repository root.
   Set only this service's `RAILWAY_DOCKERFILE_PATH=Dockerfile.teltonika`. The image builds
   with Node 22 and starts `node dist/teltonika/server.js`; clear inherited API start-command
   overrides. Exact start command: `node dist/teltonika/server.js`. The Dockerfile copies
   explicit sources and never includes `.env` files or the migration runner/SQL directory.
5. Reference the existing PostgreSQL/Redis variables, set `NODE_ENV=production`, `PORT=8080`,
   `TELTONIKA_TCP_PORT=5027`, matching `LOCATION_TTL_SECONDS`, and optionally metrics token.
   Start with one replica, continuous operation (no sleep/serverless), healthcheck `/ready`,
   restart on failure, and at least 15 seconds graceful termination time.
6. Under that service's **Settings -> Networking -> TCP Proxy**, enter internal port `5027`.
   Railway generates a public hostname and public port. Use that exact pair in TCT. The
   public port is not necessarily 5027. An HTTP `*.up.railway.app` domain is not a TCP endpoint.
7. Register or update the physical IMEI through the HTTPS API as described above, confirm
   `status=active`, `is_test_vehicle=true`, `public_visible=false` and no active Android
   session on the pilot unit, then test LTE
   traffic. HTTP health listens on `PORT`, independently of the TCP proxy. Do not create a
   public HTTP domain for the receiver just to support raw TCP.

Receiver variables (use Railway's reference-variable picker for the actual service names):

```dotenv
NODE_ENV=production
PORT=8080
TELTONIKA_TCP_PORT=5027
RAILWAY_DOCKERFILE_PATH=Dockerfile.teltonika
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
LOCATION_TTL_SECONDS=240
TELTONIKA_MAX_LIVE_AGE_SECONDS=240
```

`Postgres` and `Redis` above are examples, not verified service names. Select the existing
private connection variables whose hosts end in `.railway.internal`, not the public TCP
database URLs. Keep the API's database SSL policy and freshness settings; do not disable
TLS verification. Optional `TELTONIKA_METRICS_TOKEN` is a new random secret, not an admin JWT.
The receiver does not require `JWT_SECRET`, SMTP, Google credentials or an HTTP debug token.
Private service references and the custom Dockerfile setting follow the official
[private networking](https://docs.railway.com/networking/private-networking) and
[Dockerfile](https://docs.railway.com/builds/dockerfiles) guides. Configure `/ready` on
`PORT=8080` per the [healthcheck guide](https://docs.railway.com/deployments/healthchecks).

The supplied Dockerfile is selected explicitly so it cannot replace the API build.
The actual Railway project/service IDs, deployment permissions, variables and generated
proxy address must be verified in the user's account before deployment.

## TCT pilot configuration

Known values are from the reported hardware setup; verify them in the connected device:

| Setting | Pilot value |
| --- | --- |
| Model / observed firmware | FTC927 / 3.0.7 |
| APN | `TM` (Things Mobile) |
| Mexico roaming network observed | Movistar, LTE Cat 1 |
| Transport / codec | TCP / Codec 8 Extended |
| Server hostname / port | Pending: Railway **TCP Proxy** generated pair |
| Moving record / send period | 30 s / 30 s, minimum saved records 1 |
| Idling record / send period | 60 s / 60 s, minimum saved records 1 |
| Movement source | Accelerometer |
| External power | Reported 12 V DC |

Configure Mobile network/server and tracking/data collection in TCT; exact labels depend
on firmware/tool version. Do not add a schedule that suppresses history ingestion. Check
roaming data settings as well as home-network settings so the intervals apply in Mexico.

After Railway generates the endpoint: put only its TCP hostname into **Domain** (no
`http://`, `https://`, path or port suffix), and put its generated **public TCP port** into
**Port**. Do not enter internal port 5027 unless Railway actually generated that same
public port. Select TCP and Codec 8 Extended, save/write to the device, then verify
`last_connected_at`, `last_seen_at`, stored records and valid GPS fixes. These fields use
the pair generated by [Railway TCP Proxy](https://docs.railway.com/networking/tcp-proxy).

## First real-device checklist

- [ ] Staging migrations/API/receiver healthy; required production approval obtained before production changes.
- [ ] Physical IMEI registered privately, test vehicle/line/variant verified.
- [ ] TODO (P2) accepted for this private pilot; no active Android session or real passenger
      boarding tests on the pilot vehicle. Public visibility protections remain enabled.
- [ ] TCT hostname and **public TCP port** match the receiver proxy, APN `TM`, TCP, Codec 8E.
- [ ] Data/roaming enabled and SIM data balance/activation verified with the provider.
- [ ] Place powered tracker outdoors with a clear sky view; verify a real GNSS fix in TCT.
- [ ] `last_connected_at` advances, then `last_received_at`; receiver received-record count grows.
- [ ] Admin diagnostics show sane Ensenada coordinates, satellites > 0, current device UTC time,
      valid GPS, mapped vehicle and `published` after processing.
- [ ] Passenger `/buses/live`, route live and ETA still hide the pilot vehicle.
- [ ] Drive a short route safely; confirm new timestamps, speed conversion and route assignment.
- [ ] Disconnect/reconnect cellular data; buffered records remain history and newest live fix wins.
- [ ] Existing Android unit continues updating with its unchanged JWT/payload.

Cellular registration alone is not proof of a TCP session or GNSS fix. This implementation
has no real FTC927 LTE evidence until the checklist is executed.

## Troubleshooting and operations

No connection: check the generated TCP hostname/port, listener health, proxy target port,
SIM APN/data/roaming and TCT server settings. `00` handshake response: unknown/disabled
IMEI. No AVL ACK: inspect `invalid_packet` or `ingestion_failure` counters; check Codec 8E,
CRC, maximum frame size and PostgreSQL availability. Do not enable Codec 8 or Codec 12
on the AVL channel expecting them to decode as 8E.

Connected but no position: inspect exact telemetry through the admin API. Zero satellites
may accompany the **last known coordinates**, so those records are history-only.
Check antenna installation/sky view, power, GNSS diagnostics and device clock. `historical`
is normal after lost coverage. `unassigned_route`, `route_assignment_changed`,
`android_session_active` and `assignment_changed` explain mapping/priority exclusions.

Monitor receiver JSON counters and protected `/metrics` (Bearer token). Monitor PostgreSQL
pending outbox count/oldest age and database growth. All history is retained by default;
plan an approved retention/archive policy before expanding toward 500 units (30-second
sampling is up to 1.44 million records/day for 500 units). Never purge pending outbox rows.
Set storage alerts and load-test the actual Railway plan before claiming 500-device capacity.

Sockets, frame buffers, in-flight operations and rates are bounded. At capacity a socket
closes without ACK so the tracker retries. A reconnect replaces the previous socket for
that device within one process; database locks and uniqueness also protect multiple
receiver processes. Start with one replica to keep route-progress history coherent.

IMEI can be spoofed and raw TCP is not encrypted. Per-device limits/registry checks reduce
abuse but are not cryptographic authentication. Use a carrier private APN/VPN or controlled
ingress where available. `TELTONIKA_ALLOWED_PEERS` checks the actual socket peer; Railway
may present a proxy address, so do not assume it contains the SIM's public IP. HTTP JWT
and debug tokens do not authenticate this hardware protocol. A future TLS/private-network
setup needs device/network support and separate validation.

Rollback: stop/disable the receiver and devices, retain the additive schema/history, and
keep the HTTP API running. No down migration or history deletion is required.

## References

- [Teltonika Codec 8 Extended protocol and official test packet](https://wiki.teltonika-gps.com/view/Codec#Codec_8_Extended)
- [FTC927 configuration](https://wiki.teltonika-gps.com/view/FTC927_Configuration)
- [Railway TCP Proxy](https://docs.railway.com/networking/tcp-proxy)
- [Railway custom Dockerfile path](https://docs.railway.com/builds/dockerfiles)
- [Railway healthchecks and PORT](https://docs.railway.com/deployments/healthchecks)
- [Railway private networking](https://docs.railway.com/networking/private-networking)
