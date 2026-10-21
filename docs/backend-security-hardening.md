# Backend security hardening

## Confirmed findings and changes

1. **Spoofable client IP:** raw X-Forwarded-For could rotate rate-limit keys. Use Express req.ip with explicitly trusted proxy CIDRs; default is no trusted proxies.
2. **Driver telemetry without a service:** require driver authentication, sessionId, ownership and an active matching service. Recheck the service in the GPS transaction. Isolated local simulation retains its separate authorization.
3. **Authentication without Redis protection:** return 503 if the authentication counter is unavailable. Atomic Redis increments also set/repair expiry. A normalized, hashed email counter limits attempts across IPs. Public API outage behavior remains unchanged.
4. **Ended buses still visible:** remove matching memory/Redis samples on close and filter public buses against active sessions. Conditional deletion preserves a newer service. Public responses omit source and session identifiers.
5. **bcrypt truncation:** reject passwords exceeding 72 UTF-8 bytes in validation, user creation and login. Multibyte characters count by bytes, not characters.
6. **Unkeyed starts replaced active services:** reject a second active service with 409. Idempotent keyed retries preserve the original service and checkpoint deadlines; closing ends checkpoint runs.

## Deployment requirements

- These six fixes need no additional migration. The lifecycle work already in this checkout requires migrations 024 and 025 before use.
- Deploy compatible driver clients sending sessionId before enforcing the new telemetry contract. Older clients now receive 400.
- Configure TRUSTED_PROXY_CIDRS only with verified ingress addresses/networks. Never use arbitrary hop counts or trust every network. With the default, clients behind a proxy share its IP budget. Railway ingress configuration has not been verified by this local validation.
- Redis is required for authentication; an outage returns a retryable 503.
- Existing bcrypt hashes cannot recover any password suffix beyond 72 bytes. Affected accounts need a controlled password reset; do not silently truncate passwords.
- Changes are local; nothing has been pushed or deployed.

## Validation

- test:hardening: 8 passing tests covering proxy spoofing, Redis failure, account quotas, UTF-8 password boundaries, telemetry, visibility and session lifecycle.
- test:tracking: 13 passing tests covering direction evidence, GPS freshness, replay, check-ins and lifecycle.
- Admin authentication, database security, fleet, tenancy and local simulation checks exercised; affected legacy assertions updated to require active driver sessions and forbid admin telemetry.
- Disposable PostgreSQL/Redis local integration passed: publish, close, reject later positions, remove public visibility, preserve newer cache entries, atomic counter expiry and restart/retry behavior.
- Known unrelated regression: route-import.test.js still expects passenger location submission to create bus telemetry (201); the current passenger boundary rejects its fixture with 403. Its import/geometry fixture needs updating without weakening authorization.

This is a targeted code audit, not a guarantee that all security issues have been found or a production penetration test.
