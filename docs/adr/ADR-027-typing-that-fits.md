# ADR-027: Typing that fits

## Status

Accepted on 18 Nov 2026 (Sprint 7a). The owner asked for three things:
- customer phone numbers checked for the country's format and length;
- every box to take only what fits it: capital first letters in names, commas and decimals in amounts;
- totals added up automatically, starting with the value of stock.

## Context

- **Phone numbers.** The API already checked customer phones against the business's country, but only with the small phone rules ("min" metadata), which mainly check length. The screens checked nothing: a wrong number showed up only after saving, as "Enter a valid phone number". Business, shop and staff phones had to be typed in international form (+234…).
- **Amounts.** Each screen turned typed amounts into stored amounts its own way, and all of them assumed two decimals. That is wrong for currencies with no decimals (XOF, UGX, JPY) or three (KWD, BHD). Labels hard-coded "(₦)".
- **Times.** Several screens showed times in Lagos time, whatever the business's time zone.
- **Totals.** The stock list showed no totals.

## Decision

### Shared rules, one place

`packages/contracts/src/typing.ts` has no dependencies and is safe for every screen:
- `currencyDigits` gives a currency's decimals. It comes from the same `Intl` data as `formatMoney`, so what is typed and what is shown always agree.
- `typeNumber` and `typeAmount` give live grouping: "1500.5" becomes "1,500.5", letters are dropped, and decimals are limited to the currency's.
- `parseAmount` and `amountText` convert between typed text and stored minor units.
- `capitaliseWords`, `capitaliseFirst` and `tidyName` handle names.
- `tidyEmail` and `typeDigits` handle emails and digit codes.

`packages/contracts/src/phone.ts` checks phone numbers with the full country rules (`libphonenumber-js/max`):
- `checkPhone` gives E.164 or a problem: `too_short`, `too_long` or `invalid`.
- `typePhone` formats as you type.
- `phoneExample` and `dialCode` give a sample number and the dial code.
- `phoneProblemMessage` gives the API's plain error, for example "This number is too short for Ghana. Numbers there look like 023 123 4567."
- A number that fails but has a length the country allows (Nigeria has fixed lines of several lengths) is compared with the country's mobile numbers, so the message can still say "too long".
- Numbers from another country work when they start with + or 00.

### Boxes

- **The shared `Input`** gains `format` (applied as you type, keeping the cursor after the same character) and `finish` (applied when the box is left). Both controlled and uncontrolled forms see the result.
- **`components/typing.tsx`** builds on it:
  - `AmountInput` shows the currency's sign inside the box, uses the currency's decimals and pads them on leaving: "1,500.5" becomes "1,500.50".
  - `QuantityInput` allows 3 decimals.
  - `WholeNumberInput` and `DigitsInput` (for PINs) take digits only.
  - `NameInput` capitalises words; a name typed in all capitals, such as ADA OKAFOR, becomes Ada Okafor. Short acronyms such as DHL and UBA stay.
  - `SentenceInput` capitalises the first letter, for products, notes and reasons.
  - `EmailInput` uses small letters and no spaces.
- **`components/phone-input.tsx`** loads the phone rules only when a phone box is shown.
  - It formats the way the country writes numbers and shows a sample number as the placeholder.
  - When the box is left, it says what is wrong in plain words.
  - Forms check again before saving and send E.164, including customers saved with no network.
- **Every form uses them.** Labels no longer name a currency.
- **Import tables** apply the same rules to cells edited by hand. Delivery, sales and bank imports add up their money columns.

### Server

- Phone errors name the country and show an example number. This covers customers (one at a time and CSV) and the E.164 schema used for business, shop and staff phones.
- Product, sale, delivery and bank-statement imports read amounts in the business's own currency.
- Imported customer names typed all in small letters or all in capitals are written normally. Names already written with capitals are kept.
- The stock list returns `totals` for everything the search matches in the shop, not only the page shown:
  - products, and products in stock;
  - value at cost (people who may see cost only);
  - value at selling prices;
  - how many products in stock have no price.

  The sums run in SQL `numeric` and come back as whole minor units, never floating point. Stock below zero counts as none. With no network, the phone works the same sums out from its own copy (without cost, which is not kept on the phone).

### Automatic sums on screens

- **New product:** the cost of the opening stock is worked out as quantity × cost per unit, until a different total is typed.
- **Stock in:** typing the cost of one fills in the total, and typing the total works out the cost of one.

### Times

In the app, times use the business's time zone (from `usePlace()`). Public receipts and statements use the viewer's own time zone.

## Consequences

- **JavaScript budget.** The quick sale screen is at 169.2 KB of 170 KB. To stay under, the "add a customer" form inside a sale loads when it is opened, and PIN rules were split from the staff form rules so the staff screen does not carry the phone rules.
- **Separators.** Numbers use "." for decimals and "," for thousands. Other ways of writing numbers come with translations (Sprint 3D).
- **Stricter phones.** Business, shop and staff phones are now checked with the full rules. A number saved before that the full rules reject must be corrected the next time that form is saved.
