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
postgres://bizora_app:PASS@localhost/bizora
```

`PASS` is URL-encoded. The password character set is letters, digits, `-`, and `_`.

`bizora-api` and the `bizora-migrate` job also get a plain environment variable:

```text
DATABASE_SOCKET_DIR=/cloudsql/PROJECT:REGION:INSTANCE
```

The app passes that directory to postgres.js as the connection host. postgres.js then opens `/cloudsql/PROJECT:REGION:INSTANCE/.s.PGSQL.5432`. The socket directory is not part of `DATABASE_URL`. An empty host is an invalid URL, and postgres.js does not treat a query parameter as the socket path.

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

## AI capture (Vertex AI)

Photo, scan and voice capture (ADR-018) uses Gemini on Vertex AI in the same Google Cloud project. Terraform turns it on when `ai_provider = "vertex"` (staging's `terraform.tfvars` has this; production stays `off` until you choose).

Applying does three things:

1. Enables the Vertex AI API (`aiplatform.googleapis.com`).
2. Gives the API's service account (`bizora-api-run`) the **Vertex AI User** role.
3. Sets `AI_PROVIDER`, `VERTEX_PROJECT`, `VERTEX_LOCATION` (`global`), `VERTEX_MODEL` (`gemini-3.8-flash`) and `AI_DAILY_CAPTURE_LIMIT` (50) on the API.

```bash
cd infra/terraform/envs/staging
terraform init
terraform plan   # expect: 1 API enabled, 1 IAM binding, bizora-api updated with 5 env vars
terraform apply
```

There is no key or secret to add; the API signs in as its service account. Check:

- Signed in as an owner, Stock → Record a delivery shows **Snap the invoice or say what arrived**. If it does not, `AI_PROVIDER` is still `off`.
- A blurry or empty photo should give "No rows could be read". A clear one fills the table.

Costs: each photo or voice note is one Gemini request, billed to the project by Vertex AI. The daily limit per organization caps them. Change `ai_daily_capture_limit` or `vertex_model` in Terraform when needed, and check the model's retirement date on the Vertex AI model lifecycle page before it arrives.

## First apply

Run the same sequence in `infra/terraform/envs/staging`, then in `infra/terraform/envs/prod`. Read the plan before you apply. Do not apply production until staging is healthy.

```bash
cd infra/terraform/envs/staging
terraform init
terraform plan
terraform apply
```

The first apply creates the JWT secret with no versions, then Cloud Run tries to mount `JWT_SECRET`. That step fails until a version exists. Everything created before that failure stays in state. Add the secret, then apply again.

Generate 48 random bytes (64 characters of base64, more than the 32-character minimum). Do not commit the value, do not print it, and do not pass it as a shell argument that lands in a repo file.

Staging with OpenSSL:

```bash
openssl rand -base64 48 | gcloud secrets versions add bizora-jwt-secret \
  --project=bizora-staging \
  --data-file=-
```

Production with OpenSSL:

```bash
openssl rand -base64 48 | gcloud secrets versions add bizora-jwt-secret \
  --project=bizora-productions \
  --data-file=-
```

Windows PowerShell, without OpenSSL and without a pipe. This writes base64 to a temp file as UTF-8 with no BOM and no trailing newline, adds that file as the secret version, then deletes the file even if `gcloud` fails.

Staging:

```powershell
$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$secret = [Convert]::ToBase64String($bytes)
$path = Join-Path $env:TEMP ("bizora-jwt-" + [guid]::NewGuid().ToString("n") + ".txt")
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($path, $secret, $utf8)
try {
  gcloud secrets versions add bizora-jwt-secret --project=bizora-staging --data-file=$path
} finally {
  Remove-Item -LiteralPath $path -Force
}
```

Production:

```powershell
$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$secret = [Convert]::ToBase64String($bytes)
$path = Join-Path $env:TEMP ("bizora-jwt-" + [guid]::NewGuid().ToString("n") + ".txt")
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($path, $secret, $utf8)
try {
  gcloud secrets versions add bizora-jwt-secret --project=bizora-productions --data-file=$path
} finally {
  Remove-Item -LiteralPath $path -Force
}
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

You need `wif_provider`, `deployer_service_account`, `api_url`, `web_url`, `web_origin`, `web_run_origin`, and `cloud_sql_connection_name`. Staging also prints `custom_domain_dns_records`. `api_origin` stays the deterministic API run.app URL. `web_origin` is the public browser origin: `https://bizora-staging.baseportals.app` on staging, and the run.app host when `custom_domain` is empty. `web_run_origin` is always the run.app host and keeps serving during the cutover. Cloud Run `status.url` is a different hash host. Deploy checks the run.app origins before it ships an image and builds the web image with the API origin.

## GitHub

Repository: `peteroraz/bizora`.

Create two GitHub environments. Variables belong on the environment, under **Variables**, not **Secrets**. There are no JSON keys.

### `staging`

Open **Settings → Environments → staging** (create the environment if it is missing).

- **Deployment branches and tags:** Selected branches and tags. Add a branch rule for `main` only. Do not add tag rules. A pull request or any other branch must not be able to deploy staging.
- No required reviewers.

Variables:

| Name | Value |
| --- | --- |
| `GCP_PROJECT_ID` | `bizora-staging` |
| `GCP_REGION` | `europe-west1` |
| `GCP_WIF_PROVIDER` | staging output `wif_provider` |
| `GCP_DEPLOYER_SA` | staging output `deployer_service_account` |
| `WEB_CUSTOM_DOMAIN` | `bizora-staging.baseportals.app`, added only after the name resolves and the managed certificate is active. Until then the smoke test uses the run.app origin. |

### `production`

Open **Settings → Environments → production** and configure it **before** you publish the first release. GitHub will otherwise create the environment on the first workflow run without protection, and a workflow that selects `environment: production` would satisfy the production Workload Identity condition.

- **Required reviewers:** add them. A release must wait for approval.
- **Deployment branches and tags:** Selected branches and tags. Add a tag rule `v*` (for example `v0.1.0`). Do not leave this on "all branches". The production job runs when a GitHub release is published, and the environment rule is what limits that job to version tags.

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

## Custom domain

Staging serves the web app at `https://bizora-staging.baseportals.app`. Production stays on its run.app URL. A global external HTTPS load balancer for `https://bizora.baseportals.app` is not part of this setup.

`.app` is on the HSTS preload list, so browsers will only use HTTPS. Google's managed certificate can take from 15 minutes to 24 hours after the DNS record exists. The run.app URL keeps answering during that wait. Set the GitHub variable `WEB_CUSTOM_DOMAIN` only after `https://bizora-staging.baseportals.app/health` returns 200. The deploy smoke test uses that hostname when the variable is set, and the run.app origin otherwise.

Staging tfvars set `custom_domain = "bizora-staging.baseportals.app"`. Terraform creates `google_cloud_run_domain_mapping` for `bizora-web` and prints `custom_domain_dns_records`. An empty `custom_domain` creates no mapping.

DNS is on Cloudflare:

1. Apply Terraform after the Cloud Run service exists. Domain mapping also requires the domain to be verified for the Google Cloud project.
2. Read `terraform output custom_domain_dns_records`.
3. Create each record in Cloudflare. The web name is a CNAME. Set the proxy status to **DNS only** (grey cloud). A proxied (orange cloud) record hides the Google target and the managed certificate will not issue.
4. Wait until the certificate is active, then set `WEB_CUSTOM_DOMAIN=bizora-staging.baseportals.app` on the staging GitHub environment.

`WEB_ORIGIN` and `PUBLIC_WEB_ORIGIN` are `https://bizora-staging.baseportals.app` when the custom domain is set. Cookies, CORS, OAuth redirect URIs, and email links use that origin. The API stays on its run.app URL.

## Email and Google sign-in

An empty Google client id does not mount the client secret. `email_provider = "console"` does not mount the email key. Staging tfvars turn Resend on and set the Google client id:

```hcl
email_provider = "resend"
email_from     = "Bizora <no-reply@mail.baseportals.app>"
```

`google_oauth_client_id` is set in `infra/terraform/envs/staging/terraform.tfvars`. Add a version of `bizora-email-api-key` before the apply that sets `email_provider = "resend"`. Add a version of `bizora-google-oauth-client-secret` before applying that client id. Cloud Run mounts `latest` and a missing version stops the new revision. Production stays on `console` until it has its own from-address and secret version, and leaves the Google client id empty.

Do not put client secrets in tfvars or git.

### Google OAuth client

1. Open [Google Cloud Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent). Create an external app. Add the scopes `openid`, `email`, and `profile` (`.../auth/userinfo.email` and `.../auth/userinfo.profile`).
2. Create an OAuth client ID of type Web application.
3. Authorized redirect URIs:
   - `http://localhost:3000/api/v1/auth/oauth/google/callback`
   - `https://bizora-staging.baseportals.app/api/v1/auth/oauth/google/callback`
4. Staging already sets `google_oauth_client_id` in `infra/terraform/envs/staging/terraform.tfvars`. Store the client secret as a secret version (PowerShell below) before applying that id. Production leaves the variable empty until its own OAuth client exists.

### Resend

The web hostname is a CNAME, so it cannot also carry the mail records. Sending uses the separate subdomain `mail.baseportals.app`.

1. In Resend, add the domain `mail.baseportals.app`.
2. In Cloudflare, create the records Resend shows. They are typically:
   - SPF: a TXT record on `mail.baseportals.app`
   - DKIM: one or more CNAME records under `mail.baseportals.app`
   - DMARC: a TXT record on `_dmarc.mail.baseportals.app`
3. Set every one of those records to **DNS only** (grey cloud). Do not proxy them.
4. Wait until Resend marks the domain verified.
5. Create an API key restricted to sending, and add it as a version of `bizora-email-api-key` before applying the Resend env values.
6. `EMAIL_FROM` is `Bizora <no-reply@mail.baseportals.app>`.

### Secret versions on Windows PowerShell

Run these after Terraform has created the secret containers. Replace the project id for production. The values are read from prompts so they are not stored in shell history as command arguments.

```powershell
$project = "bizora-staging"
$google = Read-Host "Google client secret" -AsSecureString
$email = Read-Host "Resend API key" -AsSecureString

function Add-SecretVersion($name, $secure) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $file = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($file, $plain)
    gcloud secrets versions add $name --project=$project --data-file=$file
  } finally {
    Remove-Item $file -Force
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

Add-SecretVersion "bizora-google-oauth-client-secret" $google
Add-SecretVersion "bizora-email-api-key" $email
```

Apply after the Resend key version and the Google client-secret version exist. Cloud Run then mounts `latest`. Setting `google_oauth_client_id` mounts that secret.

## Known limitations

- The API throttler is in-memory. Maximum instances stay at 1 until it moves to Redis. A second instance would give each copy its own counters.
- Staging's public web origin is `https://bizora-staging.baseportals.app` once its DNS record and managed certificate are in place. The run.app host keeps serving. Production does not have a custom domain or a load balancer yet.
- Staging sends mail with Resend from `no-reply@mail.baseportals.app` after the domain is verified and `bizora-email-api-key` has a version. Production stays on the console provider. Staging still sets `INVITE_TOKEN_EXPOSE=true` so invite tokens are also returned by the API. Production leaves that flag false.
- PostgreSQL row-level security is not enabled yet (`docs/adr/ADR-002-postgres-rls.md`).
- Debtor payments, money in and out, and Ask Zora are not implemented. Sales are (ADR-015, ADR-016); AI capture from photos and voice is in ADR-018 (switched on per environment, see below).
- There is no billing. Every organization starts on the `starter` plan (1 branch, 2 staff, 2 shop devices). To move one to `business`, run in Cloud SQL Studio: `UPDATE organization_plans SET plan_code = 'business' WHERE tenant_id = '<organization id>';`. `DEFAULT_PLAN_CODE` changes the plan given to new organizations only.
- Plan limits are checked before the insert. Two requests at the same moment could both pass the last free place.
- Shop staff auto-lock after 5 minutes without input in the browser. It cannot be changed per business yet. The server limit is the 12-hour staff refresh lifetime (`STAFF_SESSION_TTL`).
- Customer CSV import takes at most 2,000 rows and 1.5 MB per file.
- A cashier's customer search (counter lookup) needs at least 3 letters or 7 digits and returns at most 10 results, but it has no rate limit of its own yet.
- Roles are fixed (see `docs/security/roles.md`). There are no per-person permission toggles or custom roles yet.
- Offline: sales, adding a customer, stock in and stock counts work offline, and products and stock can be looked up from the copy on the phone (ADR-012, ADR-014, ADR-015). Home, the sale screen, Stock, new customer and the shop PIN screen open with no network once they have been opened online on that phone. Other screens show a "no network" page.
- Desk flow (ADR-016): taking payment and giving out goods need the network; only recording the sale works offline. Notifications are inside the app only (checked every minute); phone notifications and WhatsApp alerts are not built yet. What a customer owes counts credit sales only, until debtor payments arrive in Sprint 6.
- AI capture (ADR-018) reads photos, PDFs and voice notes into rows a person checks. It can misread handwriting, so the review table and the import checks stay in charge. It needs the network. Photos and recordings are not stored, so they cannot be looked at again later. The daily limit is per organization, not per plan yet.
- Debtors (ADR-019): what a customer owes is the balance of their credit sales; a payment cannot exceed it (no customer credit or advance payments yet). Payments older than 7 days are refused. Reminders are WhatsApp links a person taps, not automatic messages. Money a customer sends above what they owe is kept as their advance only through bank statement matching (ADR-020).
- Bank statements (ADR-020): only money in is matched; money out lines are skipped until Sprint 7. All bank accounts post to one Bank ledger account (1100); the account name typed on upload is a label only. Cash paid into the bank is taken from the main branch's drawer. Suggestions look for transfers recorded within 3 days of the bank date and the same amount. At most 5,000 lines per upload.
- Invoices and receipts (ADR-017) are PDFs that staff send through the phone's share menu (WhatsApp); they are not sent automatically yet. That needs the WhatsApp Business Platform: a verified Meta business account, a dedicated number, an approved message template, and a charge per message. Documents show the shop name, address and phone, but no logo yet.
- Product and sales CSV imports take at most 2,000 rows and 1.5 MB per file, and need the network. Discounts have no amount limits yet: only managers and owners (`sales.discount`) can give them.
- Idempotency keys are kept until pruned (`IdempotencyService.prune`, 30 days). No scheduled job runs it yet.
- The ledger (ADR-013) has no screens yet. Its only endpoints are the read-only chart of accounts and trial balance.

## What CI checks

`.github/workflows/ci.yml` runs `terraform fmt -check` and `terraform validate` for staging and production with `terraform init -backend=false`. It does not plan or apply. Pull requests also run `docker build` for the API and web Dockerfiles and do not push those images.
