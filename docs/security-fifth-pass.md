# Fifth backend consistency pass

- Journey planning applies the same public bus/session filter as the map before calculating active buses and arrivals. Ended, superseded or unauthorized samples cannot supply estimates. Live failures retain route coverage with liveAvailable=false.
- ETA loads UUID geometry from PostgreSQL before calculating, including on cold replicas and after route edits. Public visibility checks remain in place; legacy file geometries retain their existing behavior.

Validation: npm run test:security-fifth-pass covers isolated database/HTTP scenarios (active, ended, superseded sessions, unavailable live data, cold geometry, edited geometry, hidden routes), plus planner and public bus regressions.

No migration or environment change required. Changes are local; no deployment performed.
