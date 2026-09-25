# Security boundaries for the online migration

No claim of immunity to all attacks is made. Production release requires verified
controls and tests, not merely hiding actions in React.

- Browser input is untrusted. Never accept a supplied role, trainer identity,
  account owner, payment success, price, earned amount or test clock as authority.
- Use Supabase Auth to verify identity; activation and recovery require email
  possession. Date of birth is business data, never an authentication secret.
- Keep auth identities, private notes, payroll and financial records separate.
- No service-role or database credentials in browser bundles, source control,
  logs, command output or URLs. Publishable keys are allowed only with tested RLS.
- Every browser-visible table requires explicit grants plus RLS. No writable views
  or client JSON database snapshots. New endpoints get deny-by-default authorization.
- SQL binds values as parameters; never interpolate user input into SQL or identifiers.
- Privileged lookup functions use a fixed empty search_path, live auth.uid(), and
  explicit execute grants. Private schema is not exposed in Data API settings.
- Reservations and credit consumption must commit in one database transaction and
  lock or constrain conflicting slots. Retry uses an idempotency key.
- Payment totals are derived on the server. Only a verified provider callback or
  an explicitly permitted administrative operation can settle a purchase.
- Serve all text as text; no untrusted HTML or SVG uploads. Images must be decoded,
  size-limited and re-encoded. Private storage paths are not public authorization.
- Restrict CORS and redirect destinations; avoid wildcard production origins.
- Require MFA for privileged users before production use. Revoke access without
  waiting for stale JWT claims to expire. Validate sensitive session operations.
- Registration/recovery errors must not reveal account existence. Apply rate limits
  and CAPTCHA where appropriate; constrain request sizes and field lengths.
- Audit sensitive writes without copying credentials or private note contents.
- Pin dependencies and lockfiles; run dependency and secret checks before release.
- Keep a rollback plan, tested backups and separate staging/test data.

Reference: https://supabase.com/docs/guides/security/product-security
Reference: https://supabase.com/docs/guides/database/postgres/row-level-security
