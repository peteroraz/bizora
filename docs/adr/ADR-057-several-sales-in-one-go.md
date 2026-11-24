# ADR-057: Several sales in one go, and a sale typed in the search box

## Status

Accepted on 24 Nov 2026. Builds on ADR-040 (offline voice sales) and ADR-049 (record first).

## Context

- Traders want to say or type several sales at once ("Emeka bought…, next customer…"). Until now, one recording or one typed sentence made one sale, so two customers' sales said together became one sale.
- A whole sale typed into the product search box became the name of a single new item. The owner hit this on 24 Nov with "20 bag of rice, 750,000, 3 cups of ogiri, 5500, 1 catoon of indomie, 15000, new customer".
- Market wording such as "750k for all" and "catoon" was not understood.

## Decision

### Splitting

`splitSpokenSales()` (contracts, `voice/split.ts`) splits text into one text per sale. It splits only at a clear marker, never at a guess:
- marker phrases: "next customer", "another sale", "second customer", "new sale", "sale two", "customer 3"…;
- a numbered list ("1. … 2) …");
- a blank line;
- a sentence that starts with a name and a buying word ("Mama Ngozi bought…"), once the part before it already has something sold.

"New customer" is **not** a marker: it says the buyer is not in the list. Parts with nothing sold in them are dropped.

### Reviewing

- Each part is read with the existing rules and reviewed on its own ("Sale 1 of 3"), with Confirm, Edit, Leave this sale out, and Cancel.
- **Nothing is saved until that sale is confirmed.** Leaving a sale out saves nothing for it.
- After a confirmed sale saves, online or offline, the screen says it was saved and opens the next sale. The last sale opens its receipt as before.
- Each sale is its own outbox item with its own ID.

### The search box

- When the text in the product search box looks like a sale (two amounts or quantities, or one with a market word, and at least 20 characters), the results offer **Read this as a sale**. It opens the same review.
- A typed item's name may be at most 60 characters. The screen doesn't offer to sell longer text as an item.
- At the counter, the server refuses a longer typed item name (`ITEM_NAME_TOO_LONG`). A sale that arrives from an offline phone is kept as it came.

### Wording

- An amount followed by "for all", "for all of them", "for everything", "for the lot", "altogether" or "in total" is the price of the whole line.
- For a new (typed) item where that amount doesn't divide evenly, the exact amount is kept for the line (`exactTotalMinor` in the review, sent as `lineTotalMinor`), so "3 cups for ₦5,500" charges ₦5,500, not ₦5,499.99.
- "catoon", "catton" and "ctn" read as carton; "derika" as derica; "modu" as mudu.

## Consequences

- A trader can record a morning's sales in one go and check each one.
- The quick sale's first script is 169.3 KB of 170 KB. Everything here loads after the screen opens.
- A recording is still at most 30 seconds, because the speech model reads 30-second windows. Longer runs of sales are typed, or recorded in several goes.
- The split is deliberately strict. Several sales said without a marker stay one sale, and the review shows it, for the person to correct.
