# Third security review corrections

## Implemented

- Driver telemetry is authorized, canonicalized and checked against the current service before diagnostic state is recorded. Cadence state has a 1,000-entry limit, 30-minute idle expiry and periodic cleanup. Identifiers are bounded; diagnostic IPs use Express's trusted-proxy resolution.
- Public alerts check both route and stop route visibility, including inactive lines. Legacy favorite route/stop reads and writes follow the same visibility predicate. Own saved-journey metadata remains readable with available=false so a passenger can remove an unavailable favorite; no private route name or geometry is exposed.
- Both route-favorite APIs write saved_journeys through one transaction, locking the account before checking the three-item quota. Tester exemption is preserved. Legacy adds are idempotent even when the route was saved via the modern API; legacy deletion removes that route's saved entries.
- The legacy variant creation service validates coordinates through the GeoJSON parser and computes distance on the server instead of trusting supplied distance.
- Public line statistics use the same active-session filter as the live map, so residual ended-session samples do not count.

## Migration

Run npm run migrate before deploying the new backend. Migration 027 copies legacy favorites created after migration 008 that have no corresponding saved route. Older rows were already migrated by 008 and are not copied again, preventing deleted favorites from reappearing. Existing accounts above the quota retain their data but cannot add more until below the limit. Both APIs subsequently use saved_journeys; do not run old backend replicas that continue writing favorite_routes alongside the new version.

The prior pending migration 026 still requires passengers to sign in again. Nothing was deployed or pushed during this work.

## Validation

npm run test:security-third-pass builds TypeScript and exercises HTTP boundaries and isolated PostgreSQL migrations, mixed legacy/modern quotas, tester exemption, visibility, migration preservation, geometry validation, active-service statistics and bounded diagnostic state. It also runs prior security, passenger, route CRUD, tenancy and tracking regressions. Tests use disposable local/in-memory data, not production.
