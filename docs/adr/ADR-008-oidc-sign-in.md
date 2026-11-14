# ADR-008: Google and Microsoft sign-in

## Status

Accepted for Sprint 3C.

## Context

ADR-001 left OIDC as a later replacement for password verification without changing tenant guards. Sign-in must keep the existing session issuance, refresh rotation, and workspace selection.

## Decision

- The API runs the Authorization Code flow with PKCE, `state`, and `nonce` through `openid-client`. The browser starts at `GET /api/v1/auth/oauth/:provider/start` and returns to `/callback`. The transaction is an HMAC-sealed httpOnly cookie, `SameSite=Lax`, `Secure` when `COOKIE_SECURE` is on, and it lives for 10 minutes.
- Google uses `https://accounts.google.com`. Microsoft uses the `common` v2 endpoint. `openid-client` already rewrites the Microsoft `{tenantid}` issuer from the `tid` claim. The callback checks that issuer again: `https://login.microsoftonline.com/{tid}/v2.0` with `tid` a GUID.
- Users are found by `(provider, provider_subject)` in `user_identities`, which has no `tenant_id`. Email is not an identifier. `users.password_hash` is nullable.
- An existing identity signs in. A verified provider email may be linked to the one user who already owns that email (`email_verified` for Google; `email_verified` or `xms_edov` for Microsoft). An unverified email is not linked and does not create a second user. A new verified or unverified provider with no matching user creates an account and continues to organization setup. Invitation acceptance requires the provider email to be verified and equal to the invitation address.
- `returnTo` must be a same-origin relative path. The callback reuses `establishSession`.
- A user cannot unlink their last sign-in method. Password reset revokes every session for that user.
- Each provider is enabled only when both its client id and secret are set. The login and register pages ask `/api/v1/auth/providers` and hide a button when that provider is off.

## Consequences

- Local tests point `GOOGLE_OAUTH_ISSUER` and `MICROSOFT_OAUTH_ISSUER` at an HTTP mock. Those overrides are unset in Cloud Run, so production uses the real issuers.
- Client secrets are Secret Manager containers without Terraform-managed versions. Client ids are plain environment variables. An empty client id does not mount the secret, so staging can deploy before the OAuth apps exist.
