# When an alert comes in

Alerts are emailed to the addresses in `alert_emails` (Terraform, ADR-036). Errors from the API, the web server and people's browsers are in **Error Reporting**, grouped by cause. Each one shows the organization, business and shop affected (`tenantId`, `businessId`, `branchId`) and a `correlationId` that matches the API's logs.

| Alert | What it means | First steps |
|---|---|---|
| **Bizora is not answering** | `/health` failed from several places for 10 minutes. | Open Cloud Run and check the `bizora-web` and `bizora-api` revisions. Check Cloud SQL is running. Roll back to the last good revision if a deploy just went out. |
| **Bizora is giving server errors** | More than 5 server errors (5xx) in 5 minutes. | Open Error Reporting for the newest error group. If it started with a deploy, roll back. |
| **Bizora is logging errors** | More than 10 errors logged in 10 minutes. | Same as above. Browser errors (`bizora-web-browser`) can come from old phones; check how many businesses they hit. |
| **Database disk is filling up** | Cloud SQL disk is over 80% full. | Check the largest tables (`product_photos`, `journal_lines`). Increase the disk size or turn on storage auto-increase. |

## Blocked content (content security policy)

Pages refuse scripts and content from anywhere but Bizora. When a browser blocks something, the API logs a warning, "Content security policy blocked something", with the directive, what was blocked and the page. A burst of these after a deploy means the policy needs a change (`apps/web/src/lib/csp.ts`). Single ones are usually browser extensions.

## Rolling back

Run `gcloud run services update-traffic bizora-api --to-revisions=REVISION=100 --region=europe-west1`, and do the same for `bizora-web`. Database migrations only add things, so the old code still runs on the new tables.

## Incident log

Write every P1 here, and any P2 that touched more than one business (runbook step 15). Newest first.

| Date | Priority | Businesses | What happened | What was done | What stops it again |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
