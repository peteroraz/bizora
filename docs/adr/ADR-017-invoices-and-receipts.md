# ADR-017: Invoices, credit invoices and receipts

## Status

Accepted. Implements Spec Addendum v1.2 roadmap Sprint 5c. Builds on ADR-015 (sales) and ADR-016 (desk flow).

## Context

Traders hand customers paper invoices and receipts. In the desk flow the customer carries an invoice from the sales desk to the cashier and gets a receipt for what they pay. Credit customers need a document showing what they owe and by when. Customers expect these on WhatsApp, as PDFs.

## Decision

### Numbers

Each business has its own sequences (`document_sequences`, ADR-012):

| Number | Given when |
| --- | --- |
| Invoice `INV-000001` | The sales desk sends a sale to the cashier (desk flow), or a balance is left on credit (either flow). |
| Receipt `R-000001` | The money is taken: at once in the simple flow, at the cashier in the desk flow. |

- A desk sale waiting for payment has an invoice number and no receipt number. The database check `sales_number_ck` allows exactly that.
- Sales recorded before this change keep their numbers.

### Documents

`availableDocuments` decides which documents a sale has. History-only sales have none.

| Document | Available when | Says |
| --- | --- | --- |
| Invoice | The sale has an invoice number and nothing is paid yet | Items, total, and "Not paid yet. Pay at the cashier with invoice number INV-…" |
| Credit invoice | The sale has an invoice number and something is owed | Items, total, payments, balance owing and the payment due date |
| Receipt | The money has been taken | Items, total, how it was paid, and the balance and due date if anything is owed |

- An invoice that was later paid in full says "Paid in full", with the receipt number.
- Cancelled sales keep their documents, marked **CANCELLED** with the reason.
- `documentModel` builds the content with no I/O and is unit-tested. `renderPdf` (pdfkit) lays it out on A5.
- The text is embedded in DejaVu Sans, because the PDF built-in fonts have no ₦ sign. The font and pdfkit ship in the API image, and the Dockerfile checks that they do.
- Documents show the shop name, the branch with its address and phone, the customer's name, who served them and who took the money. The customer's phone number is never shown.

### Where documents can be fetched

| Route | Who |
| --- | --- |
| `GET /api/v1/sales/:id/documents/invoice` or `/receipt` | Staff who see the sale in full. The store keeper's release view gets `403`, because it shows no amounts. |
| `GET /api/v1/public/receipts/:token/documents/:type.pdf` | Anyone with the customer's receipt link. The same random token as the receipt page. |

- Responses are `application/pdf`, shown inline with a readable file name (`Credit-invoice-INV-000001.pdf`).
- They are never cached, because a sale can be cancelled later.

### Sending to WhatsApp

- **Send … PDF** on the sale fetches the PDF and opens the phone's share menu with the file attached (Web Share API). Staff pick WhatsApp and the customer.
- WhatsApp does not let a web page attach a file and choose the chat in one step, so staff choose the chat.
- Where file sharing is not available (most computers), the PDF is saved instead, and a WhatsApp link with the PDF's download link is offered.
- The customer's receipt page has download buttons for each document.

### Not now: automatic sending

Sending the PDF from the shop's own WhatsApp number without anyone tapping needs the WhatsApp Business Platform (Cloud API):

- a verified Meta business account;
- a dedicated phone number;
- an approved utility message template with a document header.

Meta charges per delivered message. Because the PDFs and the public download route already exist, this only needs a sender service and per-business settings. It will be built once a business has its Meta account.

## Consequences

- Cash desks and store keepers can match the invoice and receipt numbers the customer carries.
- Shared PDF links work for anyone with the link, just like the receipt page. The link is long and random, and the PDF never contains phone numbers or costs.
- Logos are not on documents yet. They need file uploads (planned with business settings).
