# Restoring the database

Bizora's books live in one Cloud SQL Postgres instance, `bizora-pg` (ADR-005).

## Backups

- **Daily backups** run at 03:00 UTC. The last 7 are kept.
- **Point-in-time recovery** is on in production, with 7 days of logs. It is off on staging.
- **Deletion protection** is on at both the Terraform level and the Cloud SQL level.

These are the settings in Terraform. Check them in Google Cloud and write a line here each time (pilot runbook, step 5):

| Date | Project | Backups on | Last backup (UTC) and status | Point-in-time recovery | By |
|---|---|---|---|---|---|
| | | | | | |

## Recovery point and recovery time

- **Recovery point** (how much could be lost), by design:
  - production: about 5 minutes, with point-in-time recovery;
  - staging: up to 24 hours, the daily backup.
- **Recovery time:** unknown until the drill below has been run.

Do not promise either figure to a business until a drill has measured them.

**The records export is not a backup.** An owner's records export (Settings › Download your records, ADR-045) is a copy for the owner, not a way to restore Bizora.

## When something has gone wrong

1. **Stop writes if data is being damaged.** Set `bizora-api` to 0 instances, or lock the shops affected (ADR-034).
2. **Restore into a new instance.** Never restore over `bizora-pg`. Choose one of these:
   - production, to a moment before the damage: `gcloud sql instances clone bizora-pg bizora-pg-restored --point-in-time="2026-11-20T09:15:00Z" --project=PROJECT`;
   - to a daily backup: create an empty instance as in `restore-drill.sh`, then `gcloud sql backups restore BACKUP_ID --restore-instance=NEW --backup-instance=bizora-pg`.
3. **Check the new instance.** Run the checks in step 5 of `restore-drill.sh`: the books balance, stock matches its movements, and the latest sale is where you expect.
4. **Point the API at the new instance.** Do this with Terraform: change the instance name in `sql.tf`, plan, then apply. Run the migrate job, then the deploy.
5. **Tell affected businesses** what period, if any, needs re-entering.

## The drill

Practise the restore at least once before launch, then every three months. Run it in Cloud Shell:

```bash
bash docs/runbooks/restore-drill.sh bizora-staging
```

It restores the latest backup into a temporary instance, checks the data, prints the timings and deletes the instance.

### Drill log

| Date | Project | Backup taken | Restore took | Whole drill | Books balance | Stock matches | By |
|---|---|---|---|---|---|---|---|
| | | | | | | | |
