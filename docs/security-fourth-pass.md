# Fourth backend security and reliability pass

## Changes
- Redis keeps reconnecting with a delay capped at three seconds, including after the former retry limit. Commands issued while disconnected fail promptly instead of accumulating in the offline queue. Authentication retains its fail-closed policy.
- Real passenger boarding requires the cached GPS session ID to match the active driver session. Missing or previous session IDs are rejected with 409. Tester sessions remain separate from real occupancy.
- Email registration inserts the account and its default preferences in one transaction. Token generation occurs before commit; connection release is guaranteed and welcome email only runs after commit.

## Validation
- Run npm run test:security-fourth-pass.
- Isolated PGlite tests inject a preferences failure, verify rollback and successful retry, and check mismatched/missing/matching boarding session IDs.
- A local disposable RESP endpoint exercises the actual Redis client through more than eleven failed retries, recovery and a subsequent dropped connection. No shared Redis instance is stopped.
- Existing security, Google login and passenger regression suites were also run.

No migration or environment variable change is needed. Restart or deploy the backend to activate these changes. No production deployment was performed.
