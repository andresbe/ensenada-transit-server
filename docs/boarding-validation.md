# Passenger boarding validation

Apply migration `022_passenger_boardings.sql` with the normal migration runner before deploying the updated server and passenger app. No changes to production data are required by development tests.

## Contract

- `POST /locations/update` with `sourceType: "user"` now requires an active passenger account (including authenticated guests). Identity comes from the JWT, never `sourceId`.
- Required evidence: GPS timestamp no older than 30 seconds, accuracy greater than zero and at most 50 m, and distance at most 100 m from a driver position received and sampled within 45 seconds. The driver fix must also have accuracy at most 50 m.
- The bus must be registered, available, assigned to the reporting conductor, and operating an active service on the specified route. Simulation-only and passenger-generated bus positions cannot prove boarding. Redis failure rejects verification.
- Returns `{ boarding: { id, status: "pending" | "verified", expires_at } }` inside the standard success envelope. Passenger evidence never writes to the live-bus store or Redis bus position.
- Follow-up samples must include `boardingId`. They cannot revive an ended/expired session. Only one active session is allowed per user; mutations lock the user row across server instances.
- Repeated timestamps, updates within five seconds, implausible location jumps, and more than six new sessions per hour are rejected. HTTP rate limiting also applies.
- Verification needs at least two accepted samples spanning 20 seconds, movement of at least 30 m by both passenger and bus, and travel distances differing by no more than 60 m. All proximity checks still apply. Stationary confirmations remain pending.
- `DELETE /boardings/:id` ends only that authenticated user's session and is idempotent. Silence expires eligibility after two minutes; sessions have a 12-hour upper bound.

## Occupancy and privacy

This is evidence validation, not an exact passenger counter. Any future count must include only verified, unexpired sessions with an active driver service; never count pending rows or infer an empty bus from no app users. Expired rows may retain their old status until that user's next request, so filtering `expires_at > now()` and `created_at > now() - interval '12 hours'` is mandatory. Dashboard line roles have no access to passenger coordinates.

GPS may be forged and multiple accounts can evade per-account limits. Someone following the bus in another vehicle can also meet proximity checks. This does not offer hardware attestation or proof of physical presence. Background suspension causes evidence to expire; the passenger app currently submits only while its JS runtime is running.

## Validation

`npm run build` then `node --test tests/boardings.test.js tests/database-security.test.js` uses an isolated PGlite database, including all migrations. Test on a real registered driver service with fresh GPS; remote diagnostic simulation is intentionally insufficient.
