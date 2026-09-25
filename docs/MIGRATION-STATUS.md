# ACO! — migration status

Target accounts verified in the private Safari window on 2026-09-25:
- GitHub repository: https://github.com/ACOfitness/demo
- Supabase organization: ACO! (`vhxmjllgcmcucczuxsya`)
- Supabase project: `kxbqigvxmrzxaszovdoo`
- Do not use BigBearFilm repositories, projects, authentication, or deployment credentials.

## Completed locally

The access-foundation migration creates separate tables for profiles, trainer payroll,
clients, sessions, public notes, trainer-only notes, messages, packages, earnings,
products and promotions. All tables have RLS. Browser roles have read-only grants;
private identity roles and audit records have no browser read/write grants.

Identity is derived from auth.uid() and a server-controlled enabled membership.
User-editable JWT metadata never controls permissions. Membership and substitute
expiry are checked on each query. Message access belongs to participants only,
including for administrator accounts. Former lead trainers retain access to their
historical sessions; expired substitute access does not grant perpetual history.

11 PostgreSQL authorization tests pass using PGlite and a minimal Supabase Auth
fixture. They cover anonymous access, cross-client and cross-trainer access, private
notes/payroll, administrator message isolation, expired substitutes, disabled users,
metadata role forgery, direct writes, SQL injection parameters and RLS coverage.
These are not an end-to-end production penetration test.

## Not yet completed or deployed

- GitHub Pages deployment verification. Source publication to the PUBLIC
  ACOfitness/demo repository is underway. Do not change visibility to private.
- Remote migrations, Supabase security advisors and real API tests.
- Auth login/invite/recovery and first-administrator bootstrap.
- Replacement of localStorage and synchronous client-side mutations.
- Transactional scheduling, concurrent reservation/payment protection and rate limits.
- Public registration endpoints with throttling and verified email ownership.
- Payment verification (browser payment simulation must not grant online packages).
- Protected avatar storage and signed URLs.
- End-to-end permission tests with multiple real Supabase test users.
- Deployment origin, redirect allowlist, MFA setup, backups and restore rehearsal.

The offline panel remains unchanged. No demo data, passwords, or password hashes
have been imported. The foundation is intentionally read-only from browser roles;
it must not be presented as a working online migration.

GitHub Pages workflow prepared locally (manual dispatch, tests before deployment, repository-relative asset paths). Not uploaded or deployed yet. Pages hosts the frontend only; it does not secure the offline authentication implementation.
