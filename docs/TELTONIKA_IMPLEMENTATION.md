# FTC927 implementation report

Branch: `codex/teltonika-ftc927`. **Ready for a controlled private pilot**, with the
passenger boarding TODO (P2) explicitly accepted and deferred. No merge into `main`,
Railway deployment or production migration was performed. No physical device IMEI was
registered.

## Accepted TODO (P2)

Test vehicles can still receive normal passenger boardings through the existing boarding
service when an active Android session and valid Redis/passenger evidence exist. The
resulting records have `is_test=false`. A separate readiness probe reproduced this on
both this branch and clean `origin/main`; it is not a new Teltonika receiver regression.
The missing test-vehicle guard also applies to boarding renewal.

The pilot decision defers the behavior change. `src/boardings/service.ts` contains a
comment-only TODO; boarding SQL, runtime behavior and migrations remain unchanged by this
deferral. Public discovery/live, route, ETA, journey-planning and statistics protections,
including Redis-backed visibility filtering, are preserved. Keep the unit private and
marked as a test vehicle, with no active Android driver session or real passenger boarding
tests. Fix and test boarding isolation before a broader passenger rollout. See
[the limitation and safeguards](TELTONIKA.md#todo-p2-passenger-boarding-isolation).

## Synchronization with Railway schema

Fetched `origin/main` and fast-forwarded only `codex/teltonika-ftc927` from `8c61b03`
to `d7c6e12`, preserving the dirty tracked files and all untracked implementation files.
Main added four non-overlapping files (029, 030, their schema guide and tests); no textual
conflicts, stash, reset, clean, new commit or merge commit were necessary. Local `main`
remains at `8c61b03`. A recoverable pre-sync archive and binary diff are stored locally at
`/tmp/ensenada-teltonika-sync.EluYx6/working-tree.tar.gz` and `tracked.patch` in that directory.

Removed the untracked, unapplied `029_teltonika_tracking.sql`. The receiver now uses
`tracking_devices.status`, historical `vehicle_device_assignments`, and
`vehicle_gps_locations.event_key` instead of the discarded parallel telemetry design.
Production state is based on the supplied Railway report; this task did not connect to
or modify the production database.

Applied migrations are byte-identical to `origin/main`, including:

| File | SHA-256 |
| --- | --- |
| `029_tracking_devices.sql` | `8b0fc80d89206320c53cde1875d56fd3dc6e5f76f1f2865edb95f35355c540d4` |
| `030_vehicle_gps_locations.sql` | `a6be04d37ea4830d55bb3b93fdc31c922bd4641937e2bec9700f0b5b6a3f0444` |

There is one new migration number, 031. No duplicate registry, vehicle entity or
`tracking_telemetry` table is created. The checksum tests also simulate upgrading a
populated 030 database and verify that existing Android/Teltonika history and assignments survive.

## Delivered

- Dedicated bounded TCP receiver with active-device handshake, Codec 8 Extended
  decoding, CRC validation, fragmentation/coalescing, timeouts, reconnects, per-device
  rate limits, storage backpressure, metrics and graceful shutdown.
- Durable PostgreSQL `vehicle_gps_locations` outbox before ACK, event-key deduplication and replay
  after Redis failures. Invalid fixes and historical records remain diagnostic history.
- Shared Android/Teltonika publication through the existing route geometry, progress,
  speed, direction-confidence and ETA logic. Timestamp-safe Redis publication.
- Superadmin device registration/configuration/history API. Reuse of fleet and route
  registries, explicit variant assignment, Android session priority, private pilot unit.
- Platform and line dashboard live tracking, with database-enforced line isolation.
- Separate Docker image, local simulator, automated tests and Railway/TCT guide.

## Files

Created:

- `src/teltonika/codec.ts`
- `src/teltonika/config.ts`
- `src/teltonika/normalize.ts`
- `src/teltonika/receiver.ts`
- `src/teltonika/store.ts`
- `src/teltonika/devices.routes.ts`
- `src/teltonika/server.ts`
- `src/tracking/ingestion.ts`
- `src/db/migrations/031_teltonika_ingestion.sql`
- `scripts/teltonika-simulator.js`
- `tests/teltonika-codec.test.js`
- `tests/teltonika-receiver.test.js`
- `tests/teltonika-database.test.js`
- `tests/teltonika-migration.test.js`
- `tests/teltonika-redis.test.js`
- `Dockerfile.teltonika`
- `Dockerfile.teltonika.dockerignore`
- `docs/TELTONIKA.md`
- `docs/TELTONIKA_IMPLEMENTATION.md`

Modified:

- `.env.example`, `README.md`, `package.json`
- `docs/gps-tracking-schema.md`
- `src/app.ts`
- `src/boardings/service.ts` (TODO comment only; no behavior change)
- `src/modules/locations/locations.types.ts`
- `src/modules/locations/locations.service.ts`
- `src/modules/routes/routes.controller.ts`
- `src/redis/cache.ts`
- `src/tracking/locations.routes.ts`
- `src/tracking/publicBuses.ts`
- `src/tenancy/adminRead.routes.ts`

The user/auth tables, mobile applications and applied historical SQL files were not edited.

## Migration and runtime

029/030 remain untouched. New additive 031 adds configuration/connection state to existing
devices, a route variant to installation history, and raw AVL JSON/revision/assignment/delivery
fields plus a pending index to existing locations. Already-stored locations default to
`skipped`, not pending. Device and installation triggers invalidate stale Redis mappings
after configuration changes, including direct SQL writes.

`tracking_device_rejections` is the only additional table: it preserves CRC-valid records
whose original coordinate/speed/heading/satellite/timestamp values cannot satisfy 030's typed
constraints. It never stores valid positions or creates vehicle entities. There are no fake
coordinates or relaxed production constraints. Exact history and IMEIs are platform-only;
limited mapping-column grants and RLS preserve line isolation. The pilot vehicle is created
only on an authorized API request, not by migration.

Receiver: `node dist/teltonika/server.js` (or `npm run start:teltonika` outside the minimal
runtime Docker image), internal TCP port `5027`, HTTP health port `PORT`
(set `8080` for this service). API keeps its existing command and port. PostgreSQL/Redis
are shared. All new environment variables and defaults are enumerated in
[TELTONIKA.md](TELTONIKA.md#environment) and `.env.example`.

## Verification

Local npm commands used Node 24.19.0 because the shell's Node 20 does not meet existing
Google auth dependency requirements. The deployment image successfully built with Node 22.

| Check | Result |
| --- | --- |
| Dependency lockfile | Unchanged; Docker build installs it using `npm ci` |
| `npm run type-check` | Passed |
| `npm run build` | Passed |
| `TELTONIKA_TEST_REDIS_URL=... npm run test:teltonika` | 18 passed, 0 failed, 0 skipped, including real isolated Redis 7 |
| `node --test tests/gps-schema.test.js tests/teltonika-database.test.js` | 2 passed; deployed schema tests unchanged |
| `TELTONIKA_TEST_REDIS_URL=... node --test --test-concurrency=1 tests/*.test.js` | 162 tests: 154 passed, 5 reported failures, 3 existing opt-in tests skipped |
| Same complete suite on clean `origin/main` (`d7c6e12`) | 148 tests: 140 passed, the same 5 failures, 3 skipped |
| `docker build -f Dockerfile.teltonika -t ensenada-teltonika:sync-test .` | Passed |
| `npm run migrate` on disposable real PostgreSQL | Main through 030, then only 031 applied; previous migrations skipped unchanged |
| Receiver startup against schema 030 | Expected exit 1 with migration hint, no DDL executed |
| Container smoke test after 031 | Ready 200; unauthorized metrics 403; TCP ACK; 2 valid fixes published; 1 invalid fix retained; shared Redis route progress; test history excluded from SQL public view |
| `git diff --check` | Passed |

The full-suite failures reproduce in a separate, clean `origin/main` archive with the same
dependencies. They represent three pre-existing failing scenarios (five failures are
reported because two parent tests also fail):

- `tests/fleet.test.js:32`: starts a route session without the now-required variant.
- `tests/security-second-pass.test.js:71`: alert fixture violates the existing line-target constraint.
- `tests/security-third-pass.test.js:41`: alert fixture violates the same existing constraint.

These unrelated tests and production rules were left unchanged. The three skips are existing
local-infrastructure opt-ins. The Teltonika Redis test ran, not skipped. Android's existing
tracking tests and the new authenticated HTTP integration passed: provider spoofing is ignored,
active Android sessions take priority, newer fixes are not rewound, and test vehicles remain
hidden in public visibility responses even for legacy sessions lacking `vehicle_id`.
No new failing scenario was found in the automated suite. The separate boarding-isolation
readiness probe exposed the accepted TODO (P2) above; it is not included in the suite's
five baseline failures.

Additional coverage includes same-timestamp distinct AVL records, exact resend deduplication,
closed assignment attribution, `inactive`/`retired` rejection, SQL-side mapping invalidation,
schema-out-of-range diagnostics, migration-number collisions and 029/030 checksum immutability.
Local test logs: `/tmp/ensenada-sync-teltonika.log`, `/tmp/ensenada-sync-all.log`,
`/tmp/ensenada-main-d7c6e12-tests.log`, `/tmp/ensenada-sync-docker-build.log`.

The final readiness review repeated type-check/build, the 18 passing Teltonika tests,
the full suite (154 passed, the same 5 failures, 3 skipped), Docker build and disposable
PostgreSQL/receiver smoke checks. The three baseline scenarios were reconfirmed on clean
`origin/main`. Logs are preserved at `/tmp/ensenada-readiness-teltonika.log`,
`/tmp/ensenada-readiness-all.log`, `/tmp/ensenada-readiness-baseline.log`,
`/tmp/ensenada-readiness-docker.log` and `/tmp/ensenada-readiness-migrations.log`.

After documenting the accepted P2, type-check/build, all 18 focused tests (including
isolated real Redis) and both schema/database tests passed again. The boarding service's
compiled output with comments removed matches the unmodified version. Hash checks confirm
that 029/030/031 and the public visibility files were preserved. The latest focused log
is `/tmp/ensenada-pr-teltonika.log`; earlier full-suite and baseline results are unchanged.

## Railway and manual actions

Follow [the deployment sequence](TELTONIKA.md#railway-preparation-no-deployment-performed).
Review existing migration history and backup first. After explicit production approval:
apply 031 via `ensenada-transit-server`, deploy the API revision, create `teltonika-ingestion` from the
same repository, select `Dockerfile.teltonika`, reference existing private PostgreSQL/Redis,
set receiver ports, configure `/ready` on `PORT=8080`, and enable TCP Proxy targeting `5027`.
Start command is exactly `node dist/teltonika/server.js`; receiver pre-deploy command must
remain empty. Required settings: `DATABASE_URL` and `REDIS_URL` referencing existing private
services, `NODE_ENV=production`, `PORT=8080`, `TELTONIKA_TCP_PORT=5027`,
`RAILWAY_DOCKERFILE_PATH=Dockerfile.teltonika`, and matching API/receiver freshness TTL.
Use one replica initially, with no unnecessary public HTTP domain.

Still required from the actual Railway project: service/environment IDs, variable
references, the generated **TCP hostname and public port**, and deployment authorization.
The cloud project's current settings were not inspected or changed in this implementation.

Known TCT inputs from the supplied setup: FTC927, observed firmware 3.0.7, Things Mobile
APN `TM`, Movistar roaming, TCP/Codec 8 Extended, accelerometer movement, 12 V reported
power, moving 30-second record/send and idling 60-second record/send, minimum records 1.
Server hostname/port must come from Railway TCP Proxy. Register the physical IMEI
securely; do not add it to source control.

The real LTE/GNSS milestone remains pending the physical test. Also pending: load testing
the chosen Railway plan at 50-500 trackers and choosing a telemetry archive/retention
policy. Route variants are explicitly assigned, not automatically switched for hardware
without driver sessions. Operating hours do not suppress records; scheduling remains a
separate vehicle-operation concern. Run the real-device checklist before public rollout.
