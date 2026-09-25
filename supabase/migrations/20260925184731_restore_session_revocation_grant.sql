-- Restore the server-only session revocation privilege required by activation
-- and administrator password resets. No grant to browser roles.
begin;
grant delete on auth.sessions to service_role;
commit;
