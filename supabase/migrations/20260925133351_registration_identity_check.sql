-- The command gateway already manages Auth users through the admin API.
-- Allow only the identifier lookup required by the registration transaction.
grant select (id) on auth.users to service_role;
