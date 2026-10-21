# Second security review: fixes and deployment

## Changes

- Google linking converts the existing account to Google authentication and removes the prior password in the same transaction as the identity link. Existing data and user ID are retained. Pre-link push devices are disabled. Non-authoritative Google emails still require the existing password before linking.
- Passenger JWTs carry a database credential version. Both authenticated/optional middleware and refresh reject missing or obsolete versions, mismatched roles and inactive accounts. Guest transfer validates its separate guest credential. A database trigger increments the version on password, email, role, status or provider changes; ordinary profile changes do not log users out.
- Push enqueue and delivery recheck active account, alert publication/validity, visible active route, active line and a currently visible subscribed route. Existing queued jobs are suppressed if no longer authorized. New subscriptions reject hidden/inactive routes.
- Both Redis index cleanup paths recheck key existence and remove the index member atomically with Lua. A newer position written after the original snapshot retains its index membership.
- Legacy PATCH /users/me uses the same profile save/validation as /users/me/profile. Direct photo_url writes are rejected; avatar upload/re-encoding remains the supported path. Preference-only updates remain supported.

## Migration and rollout

Run npm run migrate with the target backend environment before starting this backend version. Migration 026_passenger_credentials.sql adds the credential version and trigger, and repairs already-linked Google accounts. The migration runner journals applied migrations; do not execute its SQL repeatedly by hand.

All existing passenger/guest access tokens lack a version and will be rejected. Passengers must sign in again; guests need a new guest session. Existing user data is retained. Accounts linked to Google must use Google after their prior password is removed; their device can register for push again after authentication. Admin and conductor credential versions retain their separate existing mechanisms.

For production, use a coordinated deployment without old backend replicas: an old binary does not enforce the new version checks. Pause authentication and drain old replicas, run migrations, deploy the new binary, and resume traffic. Deploy the new push worker too. Do not roll back to a binary that omits credential-version validation.

No production changes or GitHub push were made during this work.

## Verification

npm run test:security-second-pass runs the compiled code against isolated PostgreSQL (PGlite), HTTP middleware, simulated verified Google claims, and a fake push transport. It checks the attack regression, old-token rejection, fresh login/refresh, profile validation, migration repair, delivery suppression and normal delivery. No real Google account or notification is used.

RUN_LOCAL_LIFECYCLE=1 node --test tests/tracking-redis-local.test.js additionally checks the Lua cleanup against the isolated local Redis using disposable keys, including a new location appearing after a stale cleanup snapshot. It does not connect to production.
