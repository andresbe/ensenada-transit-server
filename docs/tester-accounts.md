# Tester accounts

Apply migrations (including 022 and 023), then restart the backend. Accounts default to `is_tester=false`; no account is enabled automatically. This is a passenger testing capability, not an administrator role.

## Enable or revoke

An authenticated superadministrator calls `PATCH /admin/users/:userId/tester` with `{ "is_tester": true }` or `false`. Changes are audited with the acting administrator. Profile updates and registration cannot grant this flag. The server reads the flag from the database, not JWT claims or client fields. Revocation also ends active test boardings.

The flag is included in login/refresh and `GET /users/me` responses. Refresh the profile or sign in again to update the mobile UI; opening “Abordé” also refreshes the profile. Server privileges change immediately regardless of cached UI state.

## Functional exceptions

- Boarding bypasses GPS precision/proximity, mocked GPS, bus telemetry freshness, motion verification, active vehicle/service requirements, timestamp replay checks, and attempt quotas. It still needs a valid route and structurally valid request. If no bus is available, the app offers a clearly named test bus.
- Test boardings have `is_test=true`, may lack physical vehicle/service references, and must be excluded from real passenger analytics with `NOT is_test`. They do not mutate live bus tracking. The single-current-session data model is preserved by ending the previous session automatically. Test sessions expire after 12 hours of inactivity.
- Favorite creation and guest-to-account transfer skip the three-route quota for the target tester account. The app also removes its local quota and capacity caption.
- General authenticated API rate limits are skipped, including those used by report submission. Public unauthenticated traffic and sign-in rate limits remain protected.

Ownership, authentication, active-account checks, administrator/line permissions, input validation, pagination, foreign keys, and idempotency remain enforced. Testing permission does not expose another passenger's information or permit malformed records. Tester reports remain normal reports; use a local environment for destructive or high-volume tests.

## Tests

Run `npm run build`, then `node --test tests/boardings.test.js tests/boarding-http.test.js tests/tester-rate-limit.test.js tests/database-security.test.js`. These use isolated data. They verify default-off behavior, superadmin-only changes, auditing, revocation, test-session isolation, normal-account restrictions, and untrusted client-flag rejection.
