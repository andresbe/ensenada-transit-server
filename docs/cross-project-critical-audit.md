# Cross-project critical audit

Scope: backend, driver app, passenger app and dashboard. Changes remain local; no push, production migration or deployment was performed.

## Confirmed issues corrected
- Backend administrative live map: cached GPS is accepted only for the matching active vehicle, assigned driver, route and service session; authorized draft routes remain visible.
- Backend profile: validate the complete payload before writing and commit name/preferences atomically. A preferences failure now rolls back the name, with a database regression test.
- Driver authentication: bounded 12-second requests and serialized credential persistence prevent late login, refresh or native-token responses from restoring a logged-out session or overwriting a newer login.
- Passenger app: account-keyed recent destinations prevent cross-account flashes; route/destination-keyed state prevents old walking paths and selections appearing after navigation. Journey progress does not regress on repeated completion evidence. Animated values are stable and marker redraws follow appearance changes.
- Dashboard: late profile/login responses cannot resurrect logout or replace a newer account; route authorization ignores obsolete responses.
- Repaired the malformed passenger HTTP test and updated fixtures to use credential versions and verified driver sessions. Passenger GPS remains forbidden as authoritative bus telemetry.

Previous five backend security passes are documented separately in this directory; their changes and pending migrations are retained.

## Validation
- Backend: TypeScript build passed; full suite result recorded below.
- Driver: TypeScript, 33 tracking/auth tests, 30 updater tests and 5 Android native retry tests passed. Full testDebugUnitTest task succeeded after repairing generated OneDrive/Gradle cache files; no application source was weakened to bypass native compilation.
- Passenger: TypeScript passed, all 101 Node tests passed; final account-isolation test passed after explicit guest ownership/error handling. ESLint has zero errors and five existing warnings (unused declarations and array style).
- Dashboard: TypeScript, production build and all 27 tests passed. Bundle size warning remains non-blocking.
- git diff --check passed in all four repositories.

## Limits and release requirements
- This is a local code/regression audit, not proof of zero vulnerabilities. No live exploitation or production mutation was performed.
- No new APK was installed; physical long-shift background behavior and radio/network transitions still require field validation. Local-only integration cases requiring external services are explicitly skipped by the default suite.
- Migrations 024–027 and application changes still require a coordinated release; passenger credential migration invalidates older sessions intentionally.
- Do not publish these local changes until deployment is requested.

Final backend result: 135 tests, 133 passed, 2 explicitly skipped, 0 failed (90 seconds). No confirmed critical issue remains open in the reviewed scope; field and release limitations above still apply.
