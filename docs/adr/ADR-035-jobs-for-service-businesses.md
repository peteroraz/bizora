# ADR-035: Jobs for service businesses (job cards), lines without a product, deposits

## Status

Accepted on 20 Nov 2026 (Sprint 7i). From the owner's request of 19–20 Nov.

## Context

Service businesses mostly sell work, not goods: mechanics, tailors, electricians, plumbers, repairers. Until now every sale line had to be a product from the list, so a mechanic's "brake pads changed, 15,000" could not be recorded. When the voice sale heard a name that wasn't a product, it dropped it.

The owner asked for:

- **Customer first.** Every job starts with the customer, so there is a record of what was done for them before, what is going on now, and what is planned.
- **Say the job.** The AI writes a summary in its own words first, then each item on its own line. Each line can be checked, changed or taken off, and lines can be added by hand.
- **Regular jobs** are saved so they can be picked quickly, with the price filled in but changeable.
- **Parts bought for a job** go into stock records with what they cost, so they can be picked next time. The cost is changeable each time.
- **Helpers' pay** is kept separate.
- **Any day.** A job can be recorded for today, yesterday or another day.
- **Jobs not finished yet** stay open, with deposits and a balance.
- **Balances paid later** count as money in on the day they are paid, and pay this job, not older debts.
- **Research first:** the standard way such businesses record work.
- **Who records:** cashier, manager and owner. With several staff, the cashier records, because they take the money.

### Research (Nov 2026)

- **Repair orders.** Workshop software (Tekmetric, ALLDATA Shop Manager, ARI and others) keeps one repair order or job card per customer and vehicle. It holds jobs made of parts, labour and sublet (outside) work.
  - The order moves through estimate, approved, in progress (waiting for parts) and completed. Then it becomes the invoice.
  - Deposits can be taken on a repair order before it is invoiced. They are applied when the invoice is made, and cannot exceed the order total.
- **Tailors.** Tailoring apps (Orderry, ModernDarzee, Qoyod and Odoo modules) keep an order per customer with:
  - services and materials, each with its own price that can be changed on the invoice;
  - an advance payment, with the balance on collection;
  - a due date;
  - the customer's history.
- **Electricians and plumbers.** Trade apps (ServiceM8, Tradify, Fergus, Simpro, Housecall Pro):
  - turn a quote into a job, add labour and materials, and invoice when the work is done;
  - support deposits and progress payments;
  - show job profit as labour plus materials against what was charged;
  - put call-out fees, permits and similar on their own lines.
- **Accounting standard** (accrual, IFRS 15 and ASC 606):
  - a deposit is a liability (customer deposits, or unearned revenue) until the work is delivered;
  - revenue is recognised when the job is completed and invoiced;
  - materials used on a job sit in work in progress until the job is invoiced, then move to cost of sales;
  - applying a deposit debits customer deposits and credits debtors.
- **Nigerian workshops** commonly bill parts plus "workmanship" or a service charge on a job order, with the customer's name and the vehicle.

## Decision

### A job (job card)

- **Tables:** `jobs` and `job_lines` (migration 0033).
- **What a job holds:**
  - a customer, who is required (found by phone or exact name, or added with just a name);
  - what is being worked on (title);
  - the problem;
  - the AI's summary;
  - the day it came in and the day it was promised;
  - a number, JOB-000001.
- **Status:** open, then done or cancelled.
- **Line kinds:**
  - **work:** the service, charged to the customer. It can be a saved regular job, which is a product that keeps no stock. "Save as a regular job" adds one.
  - **part:** from the shop's stock. It leaves stock at once at average cost (movement `job_use`) and cannot take the shelf below zero. It is charged at the product's price unless changed; charging less needs a manager.
  - **bought:** bought outside for this job.
    - It is recorded as stock in, paid from shop cash, bank or owed to the supplier. Owed needs a supplier name.
    - It then leaves for the job at exactly what was paid.
    - The product is found by name or added, with its last cost per unit kept so it fills in next time.
    - The customer is charged what it cost, unless a different charge is given; charging less than cost needs a manager.
  - **helper:** someone paid to help, from cash, bank or owed. It is a cost, not charged to the customer.
- **Taking a line off** needs a reason. Parts come back to stock (`job_return`) and a helper's pay is reversed. A person can take off their own lines; others' lines need a manager (`sales.void`).
- **Days:** records go on the day given, today or up to 31 days back (cash, stock and ledger alike).

### Money (standard accounting)

- **Deposits.** Money taken while a job is open is a deposit. It is recorded as a customer payment linked to the job, with its own receipt number and receipt PDF.
  - The books: Cash, Bank or POS against **2100 Customer advance payments**.
  - It shows in that day's cash as "Deposits on jobs".
  - A transfer taken by staff waits for confirmation, as other transfers do (ADR-031).
- **Costs while open.** Parts and helpers wait in **1350 Jobs in progress** (a new account for every business).
- **Finishing** ("Finish and bill") turns the job into a sale with source `job`:
  - one bill, with every line printed;
  - work is credited to service income, and parts to sales (service income for service businesses);
  - the job's costs move from Jobs in progress to cost of sales;
  - deposits are taken off (customer advance payments against debtors, and allocations to the bill);
  - the rest is owed by the customer, with an optional due date;
  - a job paid in full gets a receipt; one with a balance also gets an invoice number;
  - the sale and profit count on the day the job finished.
  - If the deposits are more than the bill, finishing is refused.
- **Payments after finishing** are customer payments aimed at this job's bill only (`saleId`), never at older debts. They count as money in on the day paid.
- **Cancelling a deposit after billing:** the customer owes it on that job again (debtors against customer advance payments).
- **Cancelling a job** is only possible when it has no lines and no deposits left, so stock and money are always put right first.
- **Who does what:**
  - anyone who sells (`sales.create`) opens jobs and adds lines;
  - only those who take money (`payments.record` or `sales.collect`) take deposits and payments; in the desk flow, that means the cashier.
- **Costs:** costs of parts from stock and the job's profit show only with `prices.cost.read`. Helper and bought costs are shown to the person who entered them.

### Voice (target `job`)

- **What the AI returns:** one row per item, with kind (work, part, bought, helper or payment), description, quantity, unit, charge, cost, paid from and supplier.
- **First row:** the customer, phone, title, problem, day, promised date, finished yes or no, and a 2–3 sentence summary in the AI's own words.
- **Containers:** gallons and other containers stay in the description rather than being converted.
- **On the phone:**
  - parts are matched to stock products, and regular jobs by name;
  - anything else becomes a bought or work line;
  - payment rows fill the deposit.
- **The screen** shows "What I understood" first, then each line to change or take off, with buttons to add more. Nothing is saved until Save.

### Lines without a product at the counter

- **API:** a sale line may be `{description, quantity, unitPriceMinor}` with no product. It earns service income (4050 for goods businesses). A free one needs a manager.
- **Quick sale screen:** not added yet, because the screen is at 169.5 KB of its 170 KB budget. Jobs cover work for customers.

### Where it shows

- **Jobs** in the menu and bottom bar for service businesses. Others can switch it on in Settings → Business → modules.
- **A customer's page** shows their jobs and "New job for this customer".
- **The day's cash** shows "Deposits on jobs" and "Helpers paid for jobs".
- **The service chart of accounts** gains stock and cost of parts accounts.

## Consequences

- **Estimates:** there is no estimate or quote step with customer approval yet; a job starts as work in progress. A quote printout and customer sign-off can come next.
- **Job card PDF:** the bill uses the normal receipt and invoice PDFs. There is no printed job card yet.
- **Assigning staff:** jobs are not assigned to a technician or helper by name, and there are no time clocks.
- **Measurements:** tailoring measurements are not stored yet. The problem and notes fields hold them for now.
- **Offline:** jobs need a network (not saved offline yet).
- **Quick sale:** "something not in the list" lines are API-only until the quick sale screen has room in its JS budget.
