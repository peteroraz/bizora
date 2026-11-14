# ADR-007: Transactional email through Resend

## Status

Accepted for Sprint 3C.

## Context

Invitations, email verification, and password reset need a provider that can send HTML and plain text. The API must still boot in local development and CI when no provider is configured, and staging must keep working until an operator adds a secret version.

## Decision

- `EmailPort` is the only send API. `EMAIL_PROVIDER=console` logs the message and does not make a network call. `EMAIL_PROVIDER=resend` posts to `https://api.resend.com/emails` with `EMAIL_API_KEY`.
- Resend is the first real adapter because the integration is one HTTPS request and a bearer key, with no provider SDK. Postmark would satisfy the same port later if we need its inbound or suppression tooling. Replacing the adapter does not change callers.
- `EMAIL_FROM` is required for Resend and must be an email address, with an optional display name. The console adapter uses it when set and otherwise does not invent a remote sender.
- Invitation, verification, and reset messages include an HTML part in the teal palette and a plain-text part with the same link.
- `INVITE_TOKEN_EXPOSE` stays a dev/test switch for API responses. The email always contains the accept link.

## Consequences

- Production and staging stay on `console` until `EMAIL_PROVIDER=resend`, `EMAIL_FROM`, and a secret version exist. Cloud Run does not mount the email key until the provider is `resend`, so a missing version does not block deploy.
- A failed send is logged and does not change the public response for password reset. That response is the same whether or not the address exists.
