# Relational cutover — prepared, not yet executed

Validated 84 application/database tests and 8 real PostgreSQL integration tests on 2026-09-25. The isolated database test used 200 simultaneous logical clients and a pool of 30 connections. 200 scoped read+profile updates completed without errors, p95 547 ms locally. These results do not establish hosted Supabase capacity. Expected permission-denied and duplicate-slot errors are assertions in negative tests, not failed tests.

The production runtime inventory contained one administrator, settings, and two audit events. The import refuses any unexpected entity kinds or non-admin account: no customer data can silently disappear.

Execute deploy-relational.sql as a transaction, then deploy the committed supabase/functions/aco-api/index.ts. Verify publicState, admin login, a reversible settings write, corresponding aco_settings row_version and unchanged legacy runtime revision. Private legacy entities are retained and writes revoked. No actual payment processing or SMTP configuration is added by this release.

## Rollback boundary
Before any new relational writes, redeploy the previous API bundle from commit b3c4f199b2e70495ea90155d416343e5f5ff6d40 and restore its existing service_role INSERT/UPDATE/DELETE privileges on aco_private.runtime_entities and EXECUTE on public.aco_runtime_commit(uuid,uuid,bigint,uuid,text,jsonb,jsonb,text). Old data is preserved. Do not remove the new tables to roll back.

After new relational writes, do not revert blindly: reconcile changes back to the legacy backup or fix forward. Pause writes first to avoid divergent sources.

## Remaining operational work
Profile images still use bounded data URLs in a typed profile column; moving them to private Storage is not part of this cutover. Hosted load testing, custom SMTP and a payment provider remain separate tasks. Direct browser table reads/writes are denied; the server projects role-scoped rows after validating a live Auth session.
