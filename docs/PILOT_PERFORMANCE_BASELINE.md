# Pilot performance baseline

Pilot readiness, item 28. Measured on **23 Nov 2026** with `scripts/perf-baseline.ts`.

> **Where this was measured.** A local machine with 2 vCPUs and 7 GB of memory. The API (production build, one Node process), Postgres 16 and the load generator all ran on that same machine.
>
> It is **not** staging. Staging runs on Cloud Run with up to 4 API instances, on a `db-f1-micro` Cloud SQL instance with a shared CPU, and with real network latency. Run the same script against staging before the pilot (runbook, step 8) and add the results below. The numbers here show how the code behaves. They are not a promise about staging.

## What was measured

1. **Filling.** One new business was filled through the API, the same way the app does it: 20 products, **5,000 customers** and **10,000 sales**. A third of the sales went to a named customer; payments were half cash, half transfer.
2. **Load.** Then **20** and **50** simulated people worked at once for 30 seconds each, all in that **one** business. This is the worst case, because sales in one business share document numbers and stock rows. Each simulated person repeats:
   - open the home screen: 6 calls at once (dashboard, sales summary, cash, profit, debtors, low stock); the slowest of the 6 is counted;
   - list today's sales;
   - search customers by name;
   - list debtors;
   - record a sale, about 1 time in 8.

## Results

Filling took 309 seconds, 10 at a time.

| Call | Count | Median ms | 95th percentile ms | Slowest ms | Errors |
| --- | --- | --- | --- | --- | --- |
| Record a sale (while filling) | 10,000 | 193 | 799 | 2,427 | 0 |

**20 people at once.** 30 s, 44.7 actions a second.

| Call | Count | Median ms | 95th percentile ms | Slowest ms | Errors |
| --- | --- | --- | --- | --- | --- |
| List sales | 336 | 414 | 526 | 735 | 0 |
| Search customers | 332 | 379 | 572 | 758 | 0 |
| List debtors | 324 | 311 | 478 | 683 | 0 |
| Record a sale | 41 | 623 | 1,606 | 1,779 | 0 |
| Home screen (6 calls together) | 320 | 660 | 931 | 1,027 | 0 |

**50 people at once.** 30 s, 45.6 actions a second.

| Call | Count | Median ms | 95th percentile ms | Slowest ms | Errors |
| --- | --- | --- | --- | --- | --- |
| List sales | 350 | 842 | 1,084 | 1,201 | 0 |
| Search customers | 345 | 471 | 761 | 1,764 | 0 |
| List debtors | 333 | 379 | 1,829 | 2,402 | 0 |
| Record a sale | 50 | 1,485 | 4,180 | 4,563 | 0 |
| Home screen (6 calls together) | 300 | 2,714 | 3,381 | 3,442 | 0 |

**With no other load**, on the same full business (median of 5 calls):

| Call | ms |
| --- | --- |
| List sales | 32 |
| Sales summary | 31 |
| Profit | 55 |
| Cash | 26 |
| Search customers | 20 |
| Dashboard | 12 |
| Debtors | 11 |
| Low stock | 6 |

## What it shows

- **No errors** in 10,000 sales and about 2,500 actions under load.
- **Each call is quick on its own**, at 6 to 55 ms with 10,000 sales and 5,000 customers. Under load, the time goes to waiting for the machine's 2 CPUs.
  - The rate stayed about 45 actions a second with both 20 and 50 people. That is this machine's limit, not the code's.
  - With 50 people, the waiting is what makes the home screen take about 3 s.
- **Recording a sale is the slowest call**: about 0.6 s at the median with 20 people, and 4 s at the 95th percentile with 50. In one business, sales take turns:
  - for the next receipt number;
  - for stock on the same product (the test used 20 products);
  - for creating the books' accounts the first time.

  A pilot business has a few people, not 50. A pilot of many businesses spreads the same load across different rows.

## A bug the baseline found, and fixed

Filling began by adding 5 products with opening stock at once, in a business that had just signed up. **Four of the five failed with a server error.** The cause was a database deadlock:

- Creating the business's chart of accounts locked the business row (`FOR UPDATE`).
- Every insert that refers to the business already holds a key-share lock on that row.
- A request that had taken a document number then waited for one that had taken the row, and the other way round.

**The fix** (`chart-of-accounts.service.ts`): the chart is created under a transaction-level advisory lock instead. It still lets one request at a time create the accounts, but it does not conflict with those key-share locks.

- **Retest:** 3 rounds of 5 at once, all saved; then the whole baseline ran without an error.
- **Regression test:** `apps/web/e2e/concurrent-first-records.e2e.ts` runs against real Postgres in CI. PGlite runs one query at a time, so unit tests cannot show it.
- **Similar patterns:** two other places lock a parent row the same way: a cash count on a shop (`money.service.ts`), and adding a shop phone (`shop-device.service.ts`). Both are rare and done by one person. They are listed as low risk in the readiness report.

## Not measured

- **Staging and production:** Cloud Run cold starts, Cloud SQL `db-f1-micro`, network latency from Nigeria.
- **The web app's own speed on phones.** The quick sale screen's script budget is checked on every CI run: 170 KB, currently 169.8 to 169.9 KB. Speed on real low-end Android phones over 3G is in `docs/PILOT_MOBILE_TEST_MATRIX.md` and has not been tried on real phones yet.
- **Offline sync with many queued sales at once.** The device sends 50 at a time; this is covered by browser tests, not load tests.

## Running it

```bash
# Locally: a production build of the API on its own port
pnpm --filter @bizora/api build
NODE_ENV=production API_PORT=3041 DATABASE_URL=... JWT_SECRET=... WEB_ORIGIN=http://localhost:3000 THROTTLE_AUTH_LIMIT=500 node apps/api/dist/main.js
node --experimental-strip-types scripts/perf-baseline.ts http://localhost:3041

# Staging (makes a business full of made-up records; never production)
node --experimental-strip-types scripts/perf-baseline.ts https://bizora-staging.baseportals.app --customers 5000 --sales 10000
```

The script refuses a URL that looks like production.
