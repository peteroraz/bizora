# ADR-008: Google and Microsoft sign-in

## Status

Accepted for Sprint 3C. The Microsoft provider in this decision is withdrawn by [ADR-009](ADR-009-sign-in-providers.md). Google sign-in, PKCE, linking, and takeover protection stay.

## Context

ADR-001 left OIDC as a later replacement for password verification without changing tenant guards. Sign-in must keep the existing session issuance, refresh rotation, and workspace selection.

## Decision

- The API runs the Authorization Code flow with PKCE, `state`, and `nonce` through `openid-client`. The browser starts at `GET /api/v1/auth/oauth/:provider/start` and returns to `/callback`. The transaction is an HMAC-sealed httpOnly cookie, `SameSite=Lax`, `Secure` when `COOKIE_SECURE` is on. The seal includes `iat` and is rejected after 10 minutes, which is also the cookie lifetime.
- Google uses `https://accounts.google.com`. Microsoft uses the `common` v2 endpoint. `openid-client` already rewrites the Microsoft `{tenantid}` issuer from the `tid` claim. The callback checks that issuer again: `https://login.microsoftonline.com/{tid}/v2.0` with `tid` a GUID.
- Users are found by `(provider, provider_subject)` in `user_identities`, which has no `tenant_id`. Email is not an identifier. `users.password_hash` is nullable.
- An existing identity signs in. The account email comes only from the `email` claim. `preferred_username` may be shown as a display name and is never used to find or create a user. Google treats the email as verified only when `email_verified` is true. Microsoft treats it as verified only when `xms_edov` is true.
- An unverified provider email does not create a user and does not attach to an existing account. A verified provider email that matches an account whose `email_verified_at` is still null replaces that account in one transaction: the email is marked verified, `password_hash` is cleared, other `user_identities` rows are deleted, every session is revoked, and the audit action is `identity.takeover_protection`. A verified provider email that matches an already verified account is linked and the password is left in place. A new verified email creates an account and continues to organization setup. Invitation acceptance requires the provider email to be verified and equal to the invitation address.
- `returnTo` must be a same-origin relative path. The callback reuses `establishSession`.
- A user cannot unlink their last sign-in method. Password reset revokes every session for that user.
- Each provider is enabled only when both its client id and secret are set. The login and register pages ask `/api/v1/auth/providers` and hide a button when that provider is off.

## Consequences

- Local tests point `GOOGLE_OAUTH_ISSUER` and `MICROSOFT_OAUTH_ISSUER` at an HTTP mock. Those overrides are unset in Cloud Run, so production uses the real issuers.
- Client secrets are Secret Manager containers without Terraform-managed versions. Client ids are plain environment variables. An empty client id does not mount the secret, so staging can deploy before the OAuth apps exist.
