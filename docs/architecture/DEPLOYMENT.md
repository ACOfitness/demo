# Relational cutover — deployed 2026-09-25

Validated 84 application/database tests and 8 real PostgreSQL integration tests on 2026-09-25. The isolated database test used 200 simultaneous logical clients and a pool of 30 connections. 200 scoped read+profile updates completed without errors, p95 547 ms locally. These results do not establish hosted Supabase capacity. Expected permission-denied and duplicate-slot errors are assertions in negative tests, not failed tests.

The production runtime inventory contained one administrator, settings, and two audit events. The import refuses any unexpected entity kinds or non-admin account: no customer data can silently disappear.

Executed deploy-relational.sql atomically and deployed supabase/functions/aco-api/index.ts through the ACO! Supabase dashboard. Verified existing administrator session, dashboard and a reversible settings write (checkout_minutes 15 → 16 → 15). Relational row_version advanced 1 → 2 → 3; legacy runtime revision remained 3. Private legacy entities are retained and writes revoked. No actual payment processing or SMTP configuration is added by this release.

## Rollback boundary
Before any new relational writes, redeploy the previous API bundle from commit b3c4f199b2e70495ea90155d416343e5f5ff6d40 and restore its existing service_role INSERT/UPDATE/DELETE privileges on aco_private.runtime_entities and EXECUTE on public.aco_runtime_commit(uuid,uuid,bigint,uuid,text,jsonb,jsonb,text). Old data is preserved. Do not remove the new tables to roll back.

After new relational writes, do not revert blindly: reconcile changes back to the legacy backup or fix forward. Pause writes first to avoid divergent sources.

## Remaining operational work
Profile images still use bounded data URLs in a typed profile column; moving them to private Storage is not part of this cutover. Hosted load testing, custom SMTP and a payment provider remain separate tasks. Direct browser table reads/writes are denied; the server projects role-scoped rows after validating a live Auth session.

## Live verification

- Imported: 1 administrator, 2 products, 6 product prices, 2 historical activity entries. No existing client/trainer records were present to import.
- All public aco_* tables have RLS enabled (0 without RLS).
- anon cannot execute aco_relational_load; authenticated cannot directly SELECT aco_clients.
- service_role cannot execute the old aco_runtime_commit writer.
- Existing administrator session remained valid and the panel successfully wrote to aco_settings through the new API.
- Local suite: 84 application/PGlite tests plus 8 real PostgreSQL tests passed. Hosted multi-role and load measurements were not performed.
