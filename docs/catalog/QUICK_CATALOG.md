# Record first, organise later

A shop can record a sale by typing what it sold. Bizora remembers the item, suggests it next time, and the owner can turn it into a proper product when they want. Decision: ADR-049. The earlier typed-item behaviour is ADR-041.

## How it feels

The sale screen asks "What did you sell?". Typing `Ogb` suggests Ogbono, with the last price and unit. If nothing matches, "Use Ogbono as a new item" sells it immediately. Quantity, unit and price are enough. The customer can be left blank (no customer row is created). The price can be for one, or for all of them; the screen says which.

A new business starts able to type items. Home says to record the first sale, or to add a list of names. Onboarding can go straight to the sale screen, to the name list, or to setting up stock. None of these is required before the other.

## Quick and managed

These words are internal.

| | Quick | Managed |
| --- | --- | --- |
| What it is | A name the shop has typed, said or imported | A product |
| Searchable at the sale | Yes | Yes |
| Stock | Not tracked | When the product tracks stock |
| Price | The last price, as a suggestion | The product price, overridable |
| Cost, SKU, category, supplier | Optional, later | As set on the product |

A remembered item is not stock. Selling it ten times does not create a balance of minus ten.

## Names

The match key trims the name, collapses spaces, drops trailing `. , ; : ! ?` and lowercases it. `Ogbono`, `ogbono` and `Ogbono.` are one item. `Peak Milk 400g` and `Peak Milk 900g` are not. A close spelling is suggested, never merged on its own.

Other names (Igbogbono, Bush mango) point at the item or, after it is upgraded, at the product. Searching an other name returns the real item. Voice matching uses them too.

## Name-only list

Stock › Add a name list. Paste names, or upload a `.csv` or `.txt` file with one name per line. A heading such as "Product" is skipped. A comma-separated line keeps the first cell.

The review shows New, Already in your list, or left out. Only the new names are added. They show up in sale search. Excel files are not read.

## Units

piece, carton, bag, kg, litre and the other standard units stay. A shop can also sell in cup, mudu, bowl, heap, scoop, rubber, basin, plate, wrap, portion, or any short code it adds. For a remembered item the unit is just remembered. Packs and conversions stay on products.

## Offline

The phone caches products, remembered items, other names, last prices and units. A new item sold offline is stored with the sale. When the network returns, one item is created and the sale is applied. Sending the same sale again does not create a second item or a second sale. Two phones typing Ogbono at once still end as one row, because the name key is unique.

## Turning an item into a product

Stock › Organise what you sell lists what has been sold or added by name. The owner can save a cost for the year, or start tracking stock.

Starting stock uses only a quantity the owner types. Past sales are not converted into a balance. The remembered row keeps its id and is linked to the product, and its other names move onto the product. Old sale lines keep the description, unit, quantity and price they were recorded with.

Two remembered items can be merged by the API (`POST /api/v1/saved-items/merge`). The dropped name becomes another name of the one that is kept. Sale text is not rewritten. Two products that track stock are not merged.

## Profit

Sales, cash, transfer, POS and what is owed are always shown. Profit is shown as a number only when every goods line has a cost. Otherwise the screen says to add costs, or shows an **estimated** profit when the owner has entered one. An estimate is stored on its own, with the period, who entered it and why. It does not change the sale or the books.

Top items on the sales day list include remembered items and products together. A line with no cost is marked "Cost not set" and has no margin.

## Who can do it

| | Sales staff | Owner, admin, manager |
| --- | --- | --- |
| Sell an existing item | Yes | Yes |
| Type a new item | When the shop allows it (`catalog.quick_create`) | Yes |
| Add a name list, rename, archive | No | Yes (`catalog.manage`) |
| Set a cost | No | With `prices.cost.read` |
| Start tracking stock | No | Yes (`catalog.convert_to_managed`) |
| Merge two remembered items | No | Owner and admin (`catalog.merge`) |

Settings › Setup can turn off "Remember items we type" and "Let me add a list of names". Turning off typed selling is the existing "Only products in my list" choice.

## API

| Route | Who |
| --- | --- |
| `GET /api/v1/saved-items` | `sales.create`, `sales.read_own`, `sales.read_all` or `catalog.manage` |
| `GET /api/v1/saved-items/suggest?q=` | same |
| `POST /api/v1/saved-items/import` | `catalog.manage` |
| `PATCH /api/v1/saved-items/:id` | `catalog.manage` |
| `POST /api/v1/saved-items/:id/aliases` | `catalog.manage` |
| `DELETE /api/v1/saved-items/:id/aliases/:aliasId` | `catalog.manage` |
| `POST /api/v1/saved-items/:id/upgrade` | `catalog.convert_to_managed` |
| `POST /api/v1/saved-items/:id/cost-estimate` | `catalog.manage` and `prices.cost.read` |
| `POST /api/v1/saved-items/merge` | `catalog.merge` |
| `DELETE /api/v1/saved-items/:id` | `products.manage` or `catalog.manage` |
| `GET /api/v1/units`, `POST /api/v1/units`, `PATCH /api/v1/units/:id` | read with sale or stock read; change with `products.manage` |
| `GET /api/v1/sales/top-items?from=&to=` | `sales.read_own`, `sales.read_all` or `sales.create` |

Amounts are minor units as strings. A sale of 2 cups at ₦1,000 each is quantity `2`, `unitPriceMinor` `100000`, total `200000`.
