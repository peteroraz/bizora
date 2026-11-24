# ADR-058: Sales report by week, month and year

## Status

Accepted on 24 Nov 2026.

## Context

The Sales screen shows one day, and Money › Profit shows a day or a month. Owners asked to see their sales for a month and for a year.

## Decision

**Sales › Sales report** (`GET /api/v1/sales/report?period=week|month|year&date=&branchId=`, plus `report.csv`) needs `reports.sales.read`.

- **Periods.** A week runs Monday to Sunday. A month and a year run from the first day to the last. The period before is shown for comparison ("up 12% on the period before").
- **Money comes from the books**, the same as Money › Profit, so the two always agree to the kobo:
    - sales and service income, discounts and returns, by the day they were booked;
    - a chart by day (week and month) or by month (year);
    - every day or month shown, with zero where nothing was sold;
    - a table view of the same figures.
- **From the sales themselves**, by the business's own day (`sold_at` in its time zone), counting completed sales and those waiting for the store, and leaving out cancelled sales and history from before Bizora:
    - the number of sales and the average sale;
    - how people paid;
    - what those sales still owe today;
    - best sellers, with "cost not known" where it applies;
    - sales by person, before returns, which are booked later and not by person.
- **Who sees what.**
    - Owners and managers who see all shops get the split by shop and by person, and can choose a shop.
    - Staff tied to one shop see that shop only, with no split by shop or person.
    - Someone allowed to see only their own sales sees totals from their own sales.
- **Download.** A CSV with one row per day or month, the totals, how people paid and the best sellers. Cells are formula-safe.

## Consequences

- Month and year totals can be checked against Profit, and are by a test.
- A desk sale collected on a later day is in the books on the day it was collected, but counted by the day it was sold. On the rare day this happens, the count and the money can sit in different periods.
- No new permission, table or migration.
