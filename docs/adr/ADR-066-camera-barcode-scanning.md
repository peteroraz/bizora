# ADR-066: Scanning barcodes with the phone camera

## Status

Accepted on 24 Nov 2026. Inventory phase 6, item 3. No migration, no API change.

## Context

Products have barcodes, and product search already matches a barcode exactly. Typing 13 digits at a busy counter is slow and easy to get wrong. Shops do not have scanners; they have Android phones.

## Decision

**The browser's own reader.** Bizora uses the browser's `BarcodeDetector` (the Shape Detection API) with the back camera (`getUserMedia`, `facingMode: environment`). No library is added. It reads EAN-13/8, UPC-A/E, Code 128, Code 39, ITF and QR, whichever the browser supports. The picture never leaves the phone.

**Typing is the fallback.** The Scan button shows only where the browser has `BarcodeDetector` and a camera (Chrome on Android, for example). Elsewhere, for example Safari on iPhone, the boxes work exactly as before. If the camera is refused or fails, the reader says so in plain words and offers "Type the code instead".

**Where Scan appears:**
- **The sale screen**, beside "Find a product". A code that is one product's barcode in the phone's product list adds it to the sale at once. This works offline, because the list is on the phone. Any other code goes into the search box.
- **Counts and transfers** (product search), and **deliveries and price lists** (the product finder). A code that finds exactly one product picks it.
- **New product**, to fill the barcode.

**Size.** The reader is its own chunk, loaded only when Scan is tapped. On the sale screen the Scan button itself is loaded after the screen, so the quick sale stays within its 170 KB budget (the performance-budget e2e passes at 159 kB).

## Consequences

- Phones whose browser has no barcode reader do not get Scan. Adding a JavaScript decoder (such as ZXing) for them would cost about 100 KB and is left until a pilot asks for it.
- The e2e stands in for the camera and the reader with a fake `BarcodeDetector` and a canvas stream, so the screens are tested without hardware. The reading itself is the browser's.
- When serial numbers (PR #66) are merged, the same Scan button can fill an IMEI. That is a one-line follow-up.
