# ADR-054: Paid receipts and invoices do not say "Paid in full"

## Status

Accepted on 24 Nov 2026. Replaces one sentence of ADR-017.

## Context

Every paid receipt printed "Paid in full. Thank you for your custom." Every paid invoice printed "Paid in full. Receipt R-…". The totals already list each payment, so the extra line repeated what the customer can see. Shops that want their own thanks or payment note already set that under Settings › Branding.

## Decision

- A paid receipt and a paid invoice carry no "Paid in full" notice.
- These notices stay: CANCELLED, "Not paid yet…", and "… is owed on credit…".
- The business's own receipt message, invoice message and terms from Settings › Branding are unchanged.
- The receipt number still appears in the invoice details when the sale has been paid.

## Consequences

- Older printed copies are not changed. Only the next print of a document uses the shorter wording.
- A shop that wants a thank-you line writes it in Settings › Branding.
