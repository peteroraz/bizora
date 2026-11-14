# ADR-009: Sign-in providers

## Status

Accepted. This withdraws the Microsoft provider from [ADR-008](ADR-008-oidc-sign-in.md).

## Context

ADR-008 added Google and Microsoft beside email and password. Microsoft sign-in was never used. Keeping it means a second consent screen, a second secret, and Microsoft-only issuer and email checks (`tid`, `xms_edov`).

## Decision

Bizora supports email and password, and Google sign-in. Microsoft sign-in is removed. It is not hidden and not feature-flagged.

- `GET /api/v1/auth/oauth/microsoft/*` is not a provider route and returns 404.
- Google keeps the ADR-008 flow: Authorization Code with PKCE, `state`, and `nonce`, an HMAC-sealed httpOnly transaction cookie that includes `iat` and expires after 10 minutes, the same linking rules, and takeover protection.
- The account email comes only from the `email` claim. `preferred_username` may be shown as a display name and is never used to find or create a user. Google treats the email as verified only when `email_verified` is true.
- Migration `0010_refuse_microsoft_identities` checks `user_identities` for `provider = 'microsoft'`. If any row exists, the migration fails and does not delete user data. There is no other schema change.
- `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, and `MICROSOFT_OAUTH_ISSUER` are not configuration. The Microsoft Secret Manager secret and its IAM binding are removed.

## Consequences

- A database that already has a Microsoft identity cannot take this migration until that row is handled outside the migration. None are expected.
- Staging sets `google_oauth_client_id`. The client secret stays a Secret Manager version added by an operator. Google sign-in stays off until both values exist.
- Another provider is a new ADR. Session issuance does not change to add one.
