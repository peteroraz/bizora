# ADR-063: Reorder rules and the To buy list

## Status

Accepted on 24 Nov 2026. Inventory brief section 14. Migration `0051_reorder_rules.sql`.

## Context

Products already have one level, `products.low_stock_level`, behind the "Low" badge, the home page's low stock list and `GET /stock/low`. The brief asks for more:
- a minimum stock, a reorder point, a target and a maximum;
- a preferred supplier and the supplier's lead time;
- a model ready for later recommendations, but no forecasting now.

## Decision

**The reorder point for every shop is the low stock level.** It is not stored twice:
- the product form's low stock level and the reorder rule's reorder point are the same number;
- saving one changes the other;
- everything that already said "Low" keeps working.

**`reorder_rules` adds the rest**, for every shop (`branch_id` empty) or for one shop:
- the minimum (below it is urgent);
- what to fill up to;
- the most to keep;
- how many days the supplier takes;
- the usual supplier.

**A shop's own rule replaces the rule for every shop there.** It has its own reorder point. Parts it leaves empty fall back to the rule for every shop. The database enforces this: only a shop's rule stores a reorder point.

**Rules are checked when saved:**
- the minimum is at most the reorder point;
- fill up to is more than the reorder point;
- the most to keep is at least fill up to, and more than the reorder point.

The usual supplier must be one of the business's suppliers. Only people who manage products change rules. Staff kept to one shop cannot set the rule for every shop, or a rule for another shop. Every change is audited.

**To buy** (`GET /api/v1/stock/to-buy`, `stock.read`, for one shop) lists products at or below their reorder point there, with:
- what is on hand;
- what is on the way (transfers already sent to the shop);
- how much to buy: fill up to, but never past the most to keep, minus what is here and on the way;
- whether it is below the minimum.

The supplier is the rule's usual supplier. Failing that, it is the supplier marked preferred for the product (ADR-048), then the one who delivered last. The lead time is the rule's, or else the supplier's. People who may see cost also get an estimate at the supplier's last price per base unit. The list is grouped by supplier, so it reads as a shopping list per supplier.

`GET /api/v1/stock/low` now uses a shop's own reorder point when it has one.

## Consequences

- No forecasting. Lead time, minimum and maximum are stored, so a later recommendation, such as average daily sales × lead time, can use them without a new table.
- How much to buy is in the base unit. Rounding up to the supplier's carton or minimum order (`supplier_products.minimum_order_quantity`, `purchase_unit`) can follow.
- The product's own "Low" badge still compares with the level for every shop. Per-shop rules show in To buy and in `stock/low`.
