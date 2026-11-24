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

## Large catalogs: 1,000, 10,000 and 50,000 products

Inventory phase 6, item 5 (ADR-067). Measured on **24 Nov 2026** with `scripts/perf-catalog.ts`, on the same kind of local machine as above: 2 vCPUs, the API (production build, one process), Postgres 16 with `pg_trgm`, and the script on one machine.

### What was measured

One new business was filled through the product import, 2,000 rows at a time, to 1,000 products, then 10,000, then 50,000. The names are like a supermarket's ("Dangote Rice 50kg 0001234"):
- 20 kinds of goods and 10 brands, so a common word such as "rice" matches 1 product in 20;
- each product has a category, a price and 100 in stock.

At each size, these were called 20 times each, one at a time:
- searches: a common word, a rare phrase, part of a word, and one product's number;
- the product list's first page;
- one product's page;
- a sale of two products;
- a count line;
- the sales summary and top items.

Then the phone's full product download, which is what a phone does the first time it gets the product list for offline selling.

### Results

#### 1,000 products

Filling to this size through the product import took 18 s.

| Call | Count | Median ms | 95th percentile ms | Slowest ms | Errors |
| --- | --- | --- | --- | --- | --- |
| Search: a common word ("rice") | 20 | 36 | 78 | 78 | 0 |
| Search: a rare word ("cornflakes 2kg") | 20 | 30 | 37 | 37 | 0 |
| Search: part of a word ("semov") | 20 | 38 | 49 | 49 | 0 |
| Search: one product's number | 20 | 33 | 46 | 46 | 0 |
| Product list, first page | 20 | 17 | 30 | 30 | 0 |
| Stock lookup (one product) | 20 | 12 | 32 | 32 | 0 |
| Record a sale (2 products) | 20 | 35 | 78 | 78 | 0 |
| Count a product | 20 | 15 | 26 | 26 | 0 |
| Sales summary | 20 | 9 | 12 | 12 | 0 |
| Top items | 20 | 9 | 11 | 11 | 0 |

The phone's full product download: 0.0 s, 0.6 MB before compression.

#### 10,000 products

Filling to this size through the product import took 139 s.

| Call | Count | Median ms | 95th percentile ms | Slowest ms | Errors |
| --- | --- | --- | --- | --- | --- |
| Search: a common word ("rice") | 20 | 64 | 98 | 98 | 0 |
| Search: a rare word ("cornflakes 2kg") | 20 | 62 | 99 | 99 | 0 |
| Search: part of a word ("semov") | 20 | 65 | 104 | 104 | 0 |
| Search: one product's number | 20 | 62 | 92 | 92 | 0 |
| Product list, first page | 20 | 33 | 55 | 55 | 0 |
| Stock lookup (one product) | 20 | 12 | 16 | 16 | 0 |
| Record a sale (2 products) | 20 | 32 | 43 | 43 | 0 |
| Count a product | 20 | 13 | 22 | 22 | 0 |
| Sales summary | 20 | 9 | 14 | 14 | 0 |
| Top items | 20 | 9 | 16 | 16 | 0 |

The phone's full product download: 0.4 s, 5.8 MB before compression.

#### 50,000 products

Filling to this size through the product import took 572 s.

| Call | Count | Median ms | 95th percentile ms | Slowest ms | Errors |
| --- | --- | --- | --- | --- | --- |
| Search: a common word ("rice") | 20 | 263 | 413 | 413 | 0 |
| Search: a rare word ("cornflakes 2kg") | 20 | 81 | 119 | 119 | 0 |
| Search: part of a word ("semov") | 20 | 257 | 321 | 321 | 0 |
| Search: one product's number | 20 | 64 | 93 | 93 | 0 |
| Product list, first page | 20 | 123 | 189 | 189 | 0 |
| Stock lookup (one product) | 20 | 13 | 18 | 18 | 0 |
| Record a sale (2 products) | 20 | 30 | 39 | 39 | 0 |
| Count a product | 20 | 12 | 17 | 17 | 0 |
| Sales summary | 20 | 9 | 13 | 13 | 0 |
| Top items | 20 | 8 | 14 | 14 | 0 |

The phone's full product download: 3.4 s, 29.0 MB before compression.

### Before and after

The first run used the search as it was on `main`. It used one `OR` across all fields, so with or without trigram indexes Postgres read every product:

| Search at 50,000 products | Median before | Median after |
| --- | --- | --- |
| A rare phrase ("cornflakes 2kg") | 393 ms | 81 ms |
| One product's number | 351 ms | 64 ms |
| Part of a word ("semov") | 424 ms | 257 ms |
| A common word ("rice") | 387 ms | 263 ms |

**A bug the check found, and fixed.** Straight after importing 1,000 products, every search took about **350 ms**. A minute later the same searches took 45 ms. Postgres had not yet gathered statistics on the new rows. A product import of 200 rows or more now refreshes them when it is saved, and the 1,000-product searches above ran at 30 to 38 ms straight after the import.

### What it shows

- **Everyday calls do not slow down with the catalog's size**: one product's page, a sale, a count line, the sales summary and top items take 8 to 35 ms at 1,000 and at 50,000 products.
- **Search stays well under half a second at 50,000 products.** A specific search (a phrase, a number, a code) takes under 0.1 s. A word in 2,500 product names takes about a quarter of a second, because the screen also counts and totals every match.
- **The phone's first download is the largest cost.** At 50,000 products it is 29 MB before compression and took 3.4 s on this machine. On a 3G connection it would take minutes. Only changes are downloaded after that (cursors). A phone at a business this large should get its first download on Wi-Fi. This is listed as a known limitation.
- **Importing 50,000 products took about 10 minutes**, 2,000 rows a file. The import saves products one at a time, with each one checked and audited.

### Running it

```bash
node --experimental-strip-types scripts/perf-catalog.ts http://localhost:3041 --sizes 1000,10000,50000 --runs 20
# Again on a business already filled:
node --experimental-strip-types scripts/perf-catalog.ts http://localhost:3041 --email catalog-…@bizora.test --sizes 50000
```

The local API is started as in "Running it" above, with `NODE_ENV=development EMAIL_PROVIDER=console`, because a production configuration needs a real email provider. The script refuses a URL that looks like production.

## Not measured

- **Staging and production:** Cloud Run cold starts, Cloud SQL `db-f1-micro`, network latency from Nigeria.
- **The web app's own speed on phones.** The quick sale screen's script budget is checked on every CI run: 170 KB, currently 169.8 to 169.9 KB. Speed on real low-end Android phones over 3G is in `docs/PILOT_MOBILE_TEST_MATRIX.md` and has not been tried on real phones yet.
- **Large catalogs on staging.** The catalog check above ran locally only.
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
