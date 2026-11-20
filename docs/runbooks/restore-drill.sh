#!/usr/bin/env bash
# Restore drill (ADR-036): restores the latest backup of bizora-pg into a new,
# temporary Cloud SQL instance, checks the data, reports how long it took, and
# deletes the temporary instance. It never touches bizora-pg itself.
#
# Run it in Google Cloud Shell (it has gcloud, psql and cloud-sql-proxy):
#   bash docs/runbooks/restore-drill.sh bizora-staging
# It takes about 15-25 minutes and costs a few cents of Cloud SQL time.
set -euo pipefail

PROJECT="${1:-bizora-staging}"
REGION="europe-west1"
SOURCE="bizora-pg"
DRILL="bizora-restore-drill-$(date -u +%Y%m%d%H%M)"
TIER="${TIER:-db-f1-micro}"
PORT=5433
STARTED=$(date +%s)

cleanup() {
  if [[ -n "${PROXY_PID:-}" ]]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  if gcloud sql instances describe "$DRILL" --project="$PROJECT" >/dev/null 2>&1; then
    echo "Deleting the temporary instance $DRILL"
    gcloud sql instances delete "$DRILL" --project="$PROJECT" --quiet
  fi
}
trap cleanup EXIT

echo "1/6 Finding the latest successful backup of $SOURCE in $PROJECT"
read -r BACKUP_ID BACKUP_AT < <(gcloud sql backups list --instance="$SOURCE" --project="$PROJECT" \
  --filter="status=SUCCESSFUL" --sort-by="~windowStartTime" --limit=1 --format="value(id,windowStartTime)")
if [[ -z "${BACKUP_ID:-}" ]]; then echo "No successful backup found."; exit 1; fi
echo "    Backup $BACKUP_ID taken at $BACKUP_AT"

echo "2/6 Creating the temporary instance $DRILL ($TIER)"
gcloud sql instances create "$DRILL" --project="$PROJECT" --region="$REGION" \
  --database-version=POSTGRES_16 --edition=ENTERPRISE --tier="$TIER" \
  --no-backup --root-password="$(openssl rand -base64 24)" --quiet

echo "3/6 Restoring the backup into it"
RESTORE_STARTED=$(date +%s)
gcloud sql backups restore "$BACKUP_ID" --restore-instance="$DRILL" --backup-instance="$SOURCE" \
  --project="$PROJECT" --quiet
RESTORED=$(date +%s)

echo "4/6 Connecting through the Cloud SQL proxy"
cloud-sql-proxy --port "$PORT" "$PROJECT:$REGION:$DRILL" >/tmp/restore-drill-proxy.log 2>&1 &
PROXY_PID=$!
sleep 8
URL=$(gcloud secrets versions access latest --secret=bizora-database-url --project="$PROJECT")
PASSWORD=$(python3 -c 'import sys, urllib.parse as u; print(u.unquote(u.urlparse(sys.argv[1]).password or ""))' "$URL")

echo "5/6 Checking the restored data"
PGPASSWORD="$PASSWORD" psql "host=127.0.0.1 port=$PORT user=bizora_app dbname=bizora sslmode=disable" \
  -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
SELECT (SELECT count(*) FROM schema_migrations) AS migrations,
       (SELECT max(id) FROM schema_migrations) AS latest_migration;
SELECT (SELECT count(*) FROM organizations) AS organizations,
       (SELECT count(*) FROM businesses) AS businesses,
       (SELECT count(*) FROM branches) AS shops,
       (SELECT count(*) FROM users) AS people,
       (SELECT count(*) FROM products) AS products,
       (SELECT count(*) FROM sales) AS sales,
       (SELECT max(sold_at) FROM sales) AS latest_sale;
-- The books must balance after a restore.
SELECT (SELECT coalesce(sum(debit_minor), 0) FROM journal_lines) = (SELECT coalesce(sum(credit_minor), 0) FROM journal_lines) AS books_balance;
-- Stock on hand must match the movements behind it.
SELECT count(*) AS stock_mismatches FROM (
  SELECT b.product_id, b.branch_id FROM stock_balances b
  LEFT JOIN (SELECT product_id, branch_id, sum(quantity) AS q FROM stock_movements GROUP BY 1, 2) m
    ON m.product_id = b.product_id AND m.branch_id = b.branch_id
  WHERE b.quantity <> coalesce(m.q, 0)
) AS mismatched;
SQL

FINISHED=$(date +%s)
echo "6/6 Done"
echo "    Data as of the backup:   $BACKUP_AT"
echo "    Restore took:            $(( (RESTORED - RESTORE_STARTED) / 60 )) min"
echo "    Whole drill took:        $(( (FINISHED - STARTED) / 60 )) min"
echo "Record these in docs/runbooks/restore.md (Drill log). The temporary instance is deleted now."
