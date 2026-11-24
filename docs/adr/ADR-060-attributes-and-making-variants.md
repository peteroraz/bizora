# ADR-060: Product attributes and making variants

## Status

Accepted on 24 Nov 2026. Inventory phase 5, part 1. Builds on ADR-046 (catalog items and variants). Migration `0048_attributes.sql`.

## Context

The inventory brief (section 18) asks for attributes that are "flexible and not hard-coded into the product table", in several kinds: text, number, select, multi-select and boolean. They are used to make variants. Examples include fashion (Colour, Size), electronics (RAM, Storage), food (Weight, Flavour) and motor parts (Make, Model, Year).

## Decision

### Tables

- **`attribute_definitions`.** Per business: name (unique per business, ignoring case and spaces), kind (`select`, `multi_select`, `text`, `number`, `boolean`), an optional unit for numbers ("GB"), position, and whether it is still offered.
- **`attribute_options`.** The choices of a list attribute, unique per attribute, ignoring case and spaces.
- **`variant_attribute_values`.** A variant's value: one row per product and attribute, or one row per choice for a multi-select.
    - A row holds exactly one of: a choice, text, a number (`numeric(18,4)`), or yes/no.
    - Composite foreign keys keep every row inside its business.
    - Products stay as they are; no column was added to them.

### Making variants

- `POST /catalog/items/:id/generate-variants` takes up to 4 one-choice attributes, with the choices ticked for each, and makes one variant per combination (at most 100 a run).
- **Names.** Each variant is labelled "Red / M" and named "Polo shirt Red / M". Its values are stored, and it is made through `ProductService.createIn`, so stock, the catalog item, codes and the audit trail work as for any variant.
- **Already there.** A combination is skipped if a variant already has those choices or that label, so running it again adds only what is new.
- **Check first.** `dryRun` lists what would be made.
- **Price.** An optional everyday price is used for every new variant.
- **The item's first variant.** It keeps its name, and the owner can label or archive it.

### Routes and permissions

- `/catalog/attributes` (list, create, change, add choices, stop offering).
- `/catalog/products/:id/attributes` (read, set).
- Reading needs `stock.read`, so sales staff see attributes. Changing anything needs `products.manage`. Every change is audited.

### Screens

- **Stock › Attributes:** add attributes and choices; stop or restart offering one.
- **Product page:** "Make variants", for people who manage products. Tick choices, see what will be made, then make them. It loads only for those people.

## Consequences

- Fashion, phone and parts shops can make a grid of variants in one go, each with its own stock and price.
- Searching or filtering products by attribute values is not built yet.
- The quick sale doesn't show attributes; the variant's name already carries them.
