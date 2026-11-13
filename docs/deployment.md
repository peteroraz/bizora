# Deployment

Bizora runs on Cloud Run and Cloud SQL in `europe-west1`.

| | Staging | Production |
| --- | --- | --- |
| GCP project | `bizora-staging` | `bizora-productions` |
| Terraform state bucket | `bizora-staging-tfstate` | `bizora-productions-tfstate` |
| State prefix | `terraform/state` | `terraform/state` |
| Deploy trigger | push to `main` | GitHub release published |
| GitHub environment | `staging` | `production` |
| Cloud SQL tier | `db-f1-micro` | `db-g1-small` |
| Point-in-time recovery | off | on |
| API min instances | 0 | 1 |
| Web min instances | 0 | 1 |
| `INVITE_TOKEN_EXPOSE` | `true` | `false` |

Terraform lives in `infra/terraform/modules/bizora`. Each environment is a root module under `infra/terraform/envs`. GitHub Actions is `.github/workflows/deploy.yml`. Images are tagged with the full git SHA. Nothing is tagged `latest`.

The network choice for Cloud SQL is recorded in [ADR-005](adr/ADR-005-cloud-sql-connector.md).

## Terraform state is sensitive

Terraform generates the `bizora_app` database password and writes this URL into Secret Manager secret `bizora-database-url`:

```text
postgres://bizora_app:PASS@/bizora?host=/cloudsql/PROJECT:REGION:INSTANCE
```

`PASS` is URL-encoded. The password character set is letters, digits, `-`, and `_`.

That URL, and the password itself, are stored in the Terraform state object in the environment's state bucket. Treat the bucket like a production secret:

- Uniform bucket-level access and public access prevention.
- Object versioning, so a bad state write can be recovered.
- Access limited to the people who apply Terraform. The GitHub deployer service account does not need access to the bucket.
- Do not commit state, plan files, or `*.auto.tfvars`.

`bizora-jwt-secret` is created as an empty secret. Terraform does not write a version. You add the value yourself.

## Prerequisites

Do this once per project, before `terraform init`. Use an identity that can administer the project. Do not use the deployer service account for the first apply; Terraform creates that account.

1. The GCP project exists and billing is enabled.
2. `gcloud` is authenticated and Terraform 1.17.2 or newer is installed.
3. Create the state bucket. This is not created by Terraform.

Staging:

```bash
gcloud storage buckets create gs://bizora-staging-tfstate \
  --project=bizora-staging \
  --location=europe-west1 \
  --uniform-bucket-level-access \
  --public-access-prevention

gcloud storage buckets update gs://bizora-staging-tfstate --versioning
```

Production:

```bash
gcloud storage buckets create gs://bizora-productions-tfstate \
  --project=bizora-productions \
  --location=europe-west1 \
  --uniform-bucket-level-access \
  --public-access-prevention

gcloud storage buckets update gs://bizora-productions-tfstate --versioning
```

If the organization policy blocks `allUsers`, allow `allUsers` to hold `roles/run.invoker` on these two projects before the Cloud Run IAM bindings will apply. Both services are public for now.

## First apply

Run the same sequence in `infra/terraform/envs/staging`, then in `infra/terraform/envs/prod`. Read the plan before you apply. Do not apply production until staging is healthy.

```bash
cd infra/terraform/envs/staging
terraform init
terraform plan
terraform apply
```

The first apply creates the JWT secret with no versions, then Cloud Run tries to mount `JWT_SECRET`. That step fails until a version exists. Everything created before that failure stays in state. Add the secret, then apply again.

Generate at least 32 characters. Do not commit the value, and do not pass it as a shell argument that lands in a repo file.

Staging:

```bash
openssl rand -base64 48 | gcloud secrets versions add bizora-jwt-secret \
  --project=bizora-staging \
  --data-file=-
```

Production:

```bash
openssl rand -base64 48 | gcloud secrets versions add bizora-jwt-secret \
  --project=bizora-productions \
  --data-file=-
```

Then:

```bash
terraform apply
```

The second apply creates `bizora-api`, `bizora-web`, and the `bizora-migrate` job on the public placeholder image `us-docker.pkg.dev/cloudrun/container/hello`. That image answers `/health`, so the API startup probe can go ready before CI ships the real image. Do not execute `bizora-migrate` until CI has replaced the image. The job command is `node dist/db/migrate.js`. Never point it at `dist/db/seed.js`.

Cloud Run, Cloud SQL, and the migrate job have deletion protection. Turning that off is a deliberate edit, not part of a normal deploy.

Record the outputs:

```bash
terraform output
```

You need `wif_provider`, `deployer_service_account`, `api_url`, `web_url`, and `cloud_sql_connection_name`. `api_origin` and `web_origin` are the deterministic URLs Terraform injects (`https://SERVICE-PROJECT_NUMBER.europe-west1.run.app`). After apply, `api_url` and `web_url` should match them. CI refuses to build the web image if they do not.

## GitHub

Repository: `peteroraz/bizora`.

Create two GitHub environments. Variables belong on the environment, under **Variables**, not **Secrets**. There are no JSON keys.

### `staging`

No required reviewers. Variables:

| Name | Value |
| --- | --- |
| `GCP_PROJECT_ID` | `bizora-staging` |
| `GCP_REGION` | `europe-west1` |
| `GCP_WIF_PROVIDER` | staging output `wif_provider` |
| `GCP_DEPLOYER_SA` | staging output `deployer_service_account` |

### `production`

Create this environment and add required reviewers **before** you publish the first release. GitHub will otherwise create the environment on the first workflow run without protection, and a workflow that selects `environment: production` would satisfy the production Workload Identity condition.

Variables are the production outputs, with `GCP_PROJECT_ID=bizora-productions`.

Workload Identity:

- Staging accepts only `peteroraz/bizora` on `refs/heads/main`.
- Production accepts only `peteroraz/bizora` when the GitHub environment claim is `production`.

The production environment's required reviewers are what stop an ordinary pull request workflow from minting a production token. Keep them on.

## First deploy

Merge to `main`. `.github/workflows/deploy.yml` deploys staging:

1. Authenticate with Workload Identity Federation. No JSON key.
2. Build `apps/api/Dockerfile` and `apps/web/Dockerfile` for `linux/amd64`.
3. Tag both images with the git SHA and push them to Artifact Registry repository `bizora`.
4. Point `bizora-migrate` at the new API image and execute it with `--wait`. The deploy stops here if migrations fail. The previous API revision keeps serving.
5. Update `bizora-api`, then `bizora-web`.
6. `GET` the web service URL `/health`. The web app rewrites that path to the API. The job fails unless the status is 200.

The web image bakes `API_ORIGIN` at build time because Next.js rewrites are compiled into the standalone server. CI passes the same origin Terraform sets on the service. A local Docker build without the build arg still targets `http://localhost:3001`.

Production runs when a GitHub release is published. Approve the `production` environment when GitHub asks. The production job uses the production variables.

Artifact Registry keeps the 15 most recent versions of each image and deletes the rest.

## Rollback

List revisions:

```bash
gcloud run revisions list \
  --service=bizora-api \
  --project=bizora-staging \
  --region=europe-west1
```

Send all traffic to a previous revision:

```bash
gcloud run services update-traffic bizora-api \
  --project=bizora-staging \
  --region=europe-west1 \
  --to-revisions=REVISION_NAME=100
```

Repeat for `bizora-web` if the web image is the problem.

A later `terraform apply` does not change the container image. Terraform ignores the image, `client`, and `client_version` so CI remains the owner of what is running. To make a rollback durable, deploy the known-good SHA again:

```bash
gcloud run services update bizora-api \
  --project=bizora-staging \
  --region=europe-west1 \
  --image=europe-west1-docker.pkg.dev/bizora-staging/bizora/api:GIT_SHA
```

Do the same for `bizora-web`. Do not roll the database backward. Migrations are forward-only; write them so the previous revision still runs.

## Logs

API and web:

```bash
gcloud run services logs read bizora-api \
  --project=bizora-staging \
  --region=europe-west1

gcloud run services logs read bizora-web \
  --project=bizora-staging \
  --region=europe-west1
```

Migration executions:

```bash
gcloud run jobs executions list \
  --job=bizora-migrate \
  --project=bizora-staging \
  --region=europe-west1
```

Cloud Logging:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="bizora-api"' \
  --project=bizora-staging \
  --limit=50
```

Swap the project id for production.

## TRUST_PROXY / X-Forwarded-For

`TRUST_PROXY` is set to `true` on `bizora-api`. The NestJS adapter calls `trust proxy` with **1 hop**, which is correct for a service reached directly by Cloud Run's front end.

If you add a Google external Application Load Balancer in front of Cloud Run, there are two forwarding hops. Raise `trust proxy` to **2** (or the hop count of your path) so rate limits and audit `ip` use the real client address instead of the load balancer.

## Rate limiting

Auth and invitation-accept routes use `@nestjs/throttler` with **in-memory** storage. That is safe for a single Cloud Run instance. Terraform sets `bizora-api` `max_instance_count` to 1 in both environments for this reason. Before scaling the API to more than one instance, switch the throttler to Redis-backed storage (`REDIS_URL` is already provisioned locally and should be used in GCP as well).

## Known limitations

- The API throttler is in-memory. Maximum instances stay at 1 until it moves to Redis. A second instance would give each copy its own counters.
- There is no custom domain. Browsers use the Cloud Run `run.app` URLs.
- There is no email delivery. Staging sets `INVITE_TOKEN_EXPOSE=true` so invite tokens are returned by the API. Production sets it to `false`, so an invite cannot be delivered until email exists.
- PostgreSQL row-level security is not enabled yet (`docs/adr/ADR-002-postgres-rls.md`).
- CRM, catalog, sales, payments, inventory, and Ask Zora are not implemented.

## What CI checks

`.github/workflows/ci.yml` runs `terraform fmt -check` and `terraform validate` for staging and production with `terraform init -backend=false`. It does not plan or apply.
