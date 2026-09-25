# Activation repair, 2026-09-25

Hosted Supabase grants postgres SELECT WITH GRANT OPTION on auth.sessions, but no DELETE grant option. The earlier DELETE grant returned success with no effective privilege. The original activation claim therefore failed before writing the password.

Migration 20260925185405_app_session_revocation replaces physical deletion with a private revoked-session registry. The server records current immutable session IDs, and both current relational and legacy runtime gates reject them for every load and mutation. Token refresh retains the session ID and does not restore ACO access. Newly authenticated sessions remain permitted. Managed Auth rows are retained; this is ACO access revocation, not global removal from Supabase Auth. Direct browser access to business tables stays revoked. No SECURITY DEFINER or expanded Auth grant is used.

Validation: 27 database tests pass with service_role DELETE explicitly revoked. Includes activation/retry, concurrency, old-session read/write rejection, repeated revocation, new login, and browser-role denial. Production claim and completion executed successfully inside a rolled-back transaction. Follow-up verification: zero persisted activation claims, one client still approved, anon/client registry access false, backend insertion true. No real password or account activation changed during verification.
