# Deployment notes

Target runtime is Google Cloud Run + Cloud SQL. Secrets belong in Secret Manager.

## TRUST_PROXY / X-Forwarded-For

`TRUST_PROXY` defaults to true when `NODE_ENV=production`. The NestJS adapter currently calls `trust proxy` with **1 hop**, which is correct for a service reached directly by Cloud Run’s front end.

If you add a Google external Application Load Balancer in front of Cloud Run, there are two forwarding hops. Raise `trust proxy` to **2** (or the hop count of your path) so rate limits and audit `ip` use the real client address instead of the load balancer.

## Rate limiting

Auth and invitation-accept routes use `@nestjs/throttler` with **in-memory** storage. That is safe for a single Cloud Run instance. Before scaling the API to more than one instance, switch the throttler to Redis-backed storage (`REDIS_URL` is already provisioned locally and should be used in GCP as well). Until then, treat multi-instance rate limiting as a known limitation.

## Sessions

Apply SQL migrations in order, including `0005_session_scope_fks.sql`. Sessions are disposable: that migration deletes rows whose selected business, branch, or membership would violate the new composite foreign keys.
