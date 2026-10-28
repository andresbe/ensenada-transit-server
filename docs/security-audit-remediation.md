# Security audit follow-up

These changes address the five source-grounded hypotheses from the October 22, 2026 audit. They do not claim that production exploitation or availability impact was demonstrated.

## Alert targets

Creating an alert with a stop resolves its route under the caller's line context. A supplied route must match that stop; the alert inherits the route's line, including platform-admin requests. Public reads and push delivery omit inconsistent historical targets.

Migration `028_alert_target_integrity.sql` adds a composite stop/route foreign key and deferred ownership checks. They protect inserts and updates, including direct SQL, while retaining route/stop deletion semantics. The foreign key is initially `NOT VALID`: it enforces new writes without deleting or silently reassigning old alerts. Existing inconsistent rows require deliberate administrative repair before validating the constraint. No production migration is performed by tests.

## Driver sessions

New sessions with a route must specify `variant_id` (ida/vuelta). An invalid route/variant pair rolls back instead of silently skipping the checkpoint snapshot. Existing sessions without a variant recover from their first authorized, canonicalized GPS sample. Recovery uses the original service start time, preserving expected checkpoint times. Existing request-id retries remain idempotent; automatic direction changes remain server-managed.

## Welcome email

The trusted Markdown template is rendered before inserting escaped display text. A display name cannot create Markdown links, images or HTML markup. The plain-text version preserves the supplied name. This change does not implement email ownership verification and does not prevent mail clients from independently recognizing plain URLs.

## Push devices and shared work

Registration serializes token handoffs and updates per account. It keeps the current device plus the most recently refreshed devices, at most five records, replacing the oldest automatically. Re-registering the same token remains idempotent. This storage bound applies to tester accounts too; it does not block their test actions. Obsolete-device delivery rows are removed by the existing cascade.

The worker also limits eligibility to the five latest active devices for historical accounts, bounds new delivery insertion to 500 rows per invocation, and claims up to 25 due jobs in per-user rounds. It rechecks device ownership, eligibility and alert targets before sending. This reduces concentration of work; it is not a guarantee of throughput or protection against many malicious accounts. Existing retries, receipt handling and timeouts still apply.

## Live-location memory

Memory entries and their history expire after `max(5 minutes, 2 × LOCATION_TTL_SECONDS)`. Cleanup runs on hydration, reads and writes, throttled to once per second. Redis copies older than that window cannot reinsert expired entries. Normal stale filtering still uses `LOCATION_TTL_SECONDS`; `includeStale` retains only a bounded diagnostic window. Idle processes do not accumulate new entries, and their next access performs cleanup.

## Regression checks

`npm run test:audit-remediation` compiles TypeScript and checks the fixes using dummy identities, in-memory PostgreSQL/PGlite, isolated HTTP and mocked push transport. It includes the existing session-lifecycle and field-tracking regressions. The dedicated audit fixture stubs unused password functions (and fails if invoked) so the Windows-installed native bcrypt binary is not loaded in the Linux sandbox. It does not test password hashing, SMTP delivery, Expo delivery or Railway configuration.

The sandbox runner uses the existing Node image, no network, an empty explicit environment, read-only source/dependencies, a size-limited temporary filesystem, non-root UID, CPU/memory/process/file limits and a five-minute deadline. No application environment files or production data are mounted. Deployment requires applying migration 028 and deploying the backend; mobile API response shapes are unchanged.

Validation on October 22, 2026: TypeScript compilation passed; all nine tests in the dedicated regression command passed in the isolated Node 22 container. The migration ran against disposable PGlite, including real RLS and deferred constraints. Production migrations and provider integration were not executed. Parallel device requests are serialized by the fixture's single database connection; cross-process locking still depends on PostgreSQL transaction semantics and was not stress-tested.
