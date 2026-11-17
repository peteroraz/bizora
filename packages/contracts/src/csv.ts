/**
 * CSV reading shared by every import (customers, products, sales). No dependencies, so it runs in the browser.
 * Handles quotes, commas and line breaks inside quotes, CRLF and a leading byte-order mark.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows.map((values) => values.map((value) => value.trim()));
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Matches a file's header row to the fields an import needs, using common names traders use
 * ("Qty", "Selling price", "Item"). Returns the column index for each field that was found.
 */
export function matchColumns<F extends string>(header: string[], synonyms: Record<F, readonly string[]>): Partial<Record<F, number>> {
  const result: Partial<Record<F, number>> = {};
  const taken = new Set<number>();
  for (const field of Object.keys(synonyms) as F[]) {
    const names = synonyms[field].map(normalize);
    const index = header.findIndex((cell, position) => !taken.has(position) && names.includes(normalize(cell)));
    if (index >= 0) {
      result[field] = index;
      taken.add(index);
    }
  }
  return result;
}

export const PRODUCT_IMPORT_COLUMNS = {
  name: ["name", "product", "product name", "item", "item name", "description"],
  category: ["category", "group", "type"],
  unit: ["unit", "uom", "unit of measure", "counted in"],
  price: ["price", "selling price", "sale price", "retail price"],
  cost: ["cost", "cost price", "buying price", "purchase price"],
  quantity: ["quantity", "qty", "stock", "in stock", "quantity in stock", "opening stock", "on hand"],
  lowStock: ["low stock", "low stock level", "reorder level", "minimum", "min stock"],
  barcode: ["barcode", "sku", "code"],
  packUnit: ["pack unit", "pack", "pack type"],
  packSize: ["pack size", "units per pack", "per pack"],
  packPrice: ["pack price", "price per pack"],
} as const;
export type ProductImportField = keyof typeof PRODUCT_IMPORT_COLUMNS;

export const SALES_IMPORT_COLUMNS = {
  date: ["date", "sale date", "day", "sold on"],
  product: ["product", "item", "product name", "item name", "description", "name"],
  quantity: ["quantity", "qty", "number", "count"],
  unit: ["unit", "uom"],
  price: ["price", "unit price", "rate", "selling price"],
  total: ["total", "amount", "line total", "value"],
  payment: ["payment", "payment method", "paid by", "method", "mode"],
  customer: ["customer", "customer name", "buyer", "client"],
  phone: ["phone", "customer phone", "phone number", "mobile"],
  ref: ["ref", "reference", "receipt", "receipt no", "receipt number", "invoice", "invoice no"],
} as const;
export type SalesImportField = keyof typeof SALES_IMPORT_COLUMNS;

/** Turns CSV text into rows of named fields. Unknown columns are ignored. */
export function rowsFromCsv<F extends string>(text: string, synonyms: Record<F, readonly string[]>) {
  const [header = [], ...body] = parseCsv(text);
  const columns = matchColumns(header, synonyms);
  const rows = body.map((cells) => {
    const row = {} as Record<F, string>;
    for (const field of Object.keys(synonyms) as F[]) {
      const index = columns[field];
      row[field] = index === undefined ? "" : (cells[index] ?? "");
    }
    return row;
  });
  return { columns, rows };
}

/** Reads dates traders write: 2026-11-16, 16/11/2026, 16-11-26, 16 Nov 2026. Day comes before month. */
export function parseTraderDate(text: string): string | null {
  // Bank statements add a time ("16/11/2026 10:22:01", "2026-11-16T10:22"); only the day matters here.
  const value = text
    .trim()
    .replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\s*[AaPp][Mm])?$/, "")
    .trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(value);
  if (match) {
    const year = Number(match[3]);
    return isoDate(year < 100 ? 2000 + year : year, Number(match[2]), Number(match[1]));
  }
  // "16 Nov 2026", "16-Nov-2026", "16-Nov-26", "16 November, 2026".
  match = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{2}|\d{4})$/.exec(value);
  if (match) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf((match[2] ?? "").slice(0, 3).toLowerCase());
    const year = Number(match[3]);
    if (month >= 0) return isoDate(year < 100 ? 2000 + year : year, month + 1, Number(match[1]));
  }
  return null;
}

function isoDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}
