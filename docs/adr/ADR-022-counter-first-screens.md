# ADR-022: Screens that fit the counter (Sprint 6d)

## Status

Accepted. Comes from the 17 Nov 2026 review "Bizora review: screens, flows and industry fit", fix-list items 1–11. Two pricing decisions were made by the owner the same day: the desk flow is labelled rather than included in Starter, and Starter gets a small daily allowance of photo and voice reads.

## Context

The review walked 47 screens at 360 × 780 (Tecno and Infinix size) and found the engine sound but the screens costly:
- About 270 px of every phone screen went to the header and a banner.
- Main actions looked like plain text links.
- The sale screen needed scrolling for every sale and hid the unit being sold.
- Home showed placeholders that contradicted the shop's own sales.
- Setup refused an address its labels called optional.

## Decisions

### Layout

- **One-line header:**
  - The logo, the business name and the shop name sit on one line, with the bell and the avatar.
  - Tapping the names opens a sheet to switch business or shop. Staff tied to one shop see no switch.
  - The role badge moved to the account menu.
  - The "verify your email" banner shows on Home only and can be hidden for a week.
- **Bottom bar by role** (`bottomItemsFor` in `lib/nav.ts`), at most four items with the rest under More:
  - owners, administrators and managers: Home, Sales, Stock, Debtors;
  - cashiers: Home, Sales, Debtors, Customers;
  - store keepers: Home, Stock, Sales;
  - accountants: Home, Money, Debtors, Sales.
- **Modules not built yet** (Reports) are hidden from the menu instead of marked "Soon".
- **Page header text:**
  - `description` is information (a phone number, a date) and always shows.
  - The new `intro` is general help text, shown from tablet width up.
- **Touch size and actions:**
  - Buttons are at least 44 px (40 px for compact rows), and inputs are 44 px with 16 px text on phones.
  - Screen actions are buttons (`ActionLink`) with one filled main action; ways back are `‹ Back` links.
- **One format for dates and phones:**
  - Dates read "17 Nov 2026" (`formatDay`).
  - Nigerian numbers read "0803 123 4567" (`formatPhone`).
  - Day lists use "‹ Today ›" switchers instead of the phone's date box, which often shows US dates.
  - Credit due dates offer "In 1 week / 2 weeks / 1 month".

### Selling

- **Product tiles:** with an empty search box, the sale screen shows up to 12 product tiles. It puts what this phone sold recently first, kept per shop in the phone's storage, then the rest of the list. Tapping a product again adds one more to its line.
- **Lines:** each line has − and + buttons and unit chips with their prices (pack ₦250 · carton ₦9,500). People allowed to change prices get a "Change price" link.
- **Cash:** a "Cash given" field shows the change, or the amount short. The cashier's collect panel has it too. It is not stored.
- **Total bar:** the total and **Record sale** sit in a bar fixed above the bottom menu. The discount and note fields fold away.
- **After the sale:** the sale page offers **Next sale** as its main button.
- **Simple shops:** shops that don't use the desk flow no longer see "Paid at the cashier" or "Goods given out".
- **Sharing:** the extra ways to share are folded under "More ways to share". An unpaid invoice is never called a receipt.
- **Sales list rows** lead with the customer and show how the sale was paid (`methods` on each row).
- **Page weight:** the sale screen stays within its 170 KB budget (166.5 KB).

### Home and setup

Home:
- leads with a full-width **New sale** button for people who sell;
- shows the setup checklist first while anything is left;
- names the top three debtors.

"Cash at hand" and "Staff activity" are hidden until Sprint 7 builds them. "Money" shows only when there are bank lines to check. The checklist asks for products ("first-products", done when a product exists) instead of a sentence about what the shop sells.

Setup:
- uses large tappable choices and a full-width Continue button;
- adds trade types: pharmacy and cosmetics, fashion, electronics, building materials and auto parts. They share the retail chart of accounts, and building materials gets loading and offloading;
- asks the currency once, taken from the country, with a link to change it. Sign-up no longer asks for currency or time zone;
- orders the Nigerian address as State, City, Market, Shop number, Line. Street and postal code are folded away, and the market field says what is enough;
- turns "What do you sell?" into chips for the chosen trade.

### Customers and customer pages

- **Removing a customer:** "Remove customer" sits behind a ⋯ More menu with a confirm step.
  - A customer who still owes cannot be removed (`CUSTOMER_OWES`, 409).
  - A customer with any sale or payment is archived (`customers.archived_at`, migration 0023). They are hidden from lists, searches and bank matching, and kept on old sales.
  - Only a customer with no history is deleted.
  - Audit records `customer.archived` or `customer.deleted`.
- **Customer page:**
  - It lists the customer's purchases, using `GET /sales?customerId=`, and what they owe, with a link to their account.
  - Call and WhatsApp are buttons.
  - The add form asks for name and phone, with the rest folded.
- **Debtors:**
  - People with `customers.read` (not the cashier's counter view) see the debtor's full number and a Call button.
  - Rows say "12 days late".
- **Customer receipt and statement pages:**
  - They show the shop's logo, address, phone (Call and WhatsApp) and the owner's message: thanks on a paid receipt, "How to pay" on an unpaid invoice or statement.
  - The logo is served through the page's own token (`/public/receipts/:token/logo`, `/public/statements/:token/logo`), so it reveals nothing else.
  - The shop's phone is public on purpose; the customer's phone never is.

### Plans

- **AI reads:** the plan JSON gains `ai_daily_reads`. Starter is set to 10 and Business keeps the server's daily limit (50). Both plans now list AI as included. Capture uses the lower of the plan and server limits.
- **Desk flow:** Settings says when the plan allows fewer than the 3 staff the desk flow needs.

### Public homepage

- It is rebuilt around the brand promise, with six trader problems and how Bizora solves each.
- It shows three real phone screenshots, stored as WebP files of about 15–20 KB, lazy-loaded.
- An optional WhatsApp contact button appears only when configured.
- It shows no prices until pricing is decided.

## Consequences

- Owners reach Customers through More on phones. Debtors and Stock earned the bottom bar.
- Quick tiles are per phone, not shop-wide best sellers. Best sellers need sales reports (Sprint 7).
- Not done from the review's list: phone-number sign-up, settings sections as a list on phones, one "Add staff" flow, and credit limits formatted as you type.
