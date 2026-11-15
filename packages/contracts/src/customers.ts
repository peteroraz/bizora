import { z } from "zod";
import { isUuidV7 } from "./ids.js";
import { addressInputSchema } from "./address.js";

export const CUSTOMER_PAGE_SIZE = 25;
/** Maximum data rows in one customer CSV import (header row not counted). */
export const CUSTOMER_IMPORT_MAX_ROWS = 2000;

/** A device may choose the new customer's ID itself (UUIDv7), so it can refer to the customer while offline. */
export const customerClientIdSchema = z.object({
  id: z.string().refine(isUuidV7, "Must be a UUIDv7 created on the device.").optional(),
});

export const customerWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    phone: z.string().trim().max(32).optional(),
    isWalkIn: z.boolean().optional(),
    email: z.union([z.string().trim().email().max(320), z.literal(""), z.null()]).optional(),
    notesSummary: z.string().trim().max(2000).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(12).optional(),
    branchId: z.string().uuid().optional(),
    address: addressInputSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const walkIn = value.isWalkIn === true;
    const phone = value.phone?.trim() ?? "";
    if (!walkIn && phone.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phone"],
        message: "Enter a phone number, or mark the customer as walk-in.",
      });
    }
    if (walkIn && phone.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phone"],
        message: "A walk-in customer does not have a phone number.",
      });
    }
  });

export const customerNoteSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

export const followupCreateSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    dueAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Choose a valid time.").optional(),
    dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    assignedTo: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.dueAt && !value.dueOn) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dueOn"], message: "Choose a day." });
    }
  });

export const followupUpdateSchema = z.object({
  status: z.enum(["open", "done", "snoozed"]),
  snoozedUntil: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Choose a valid time.").optional(),
  snoozeDays: z.number().int().min(1).max(30).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const customerImportSchema = z.object({
  csv: z.string().min(1).max(1_000_000),
  commit: z.boolean().optional().default(false),
});

export type CsvRow = {
  line: number;
  name: string;
  phone: string;
  email: string;
  notes: string;
};

export function parseCustomerCsv(text: string): { headers: string[]; rows: CsvRow[]; error?: string } {
  const table = parseCsv(text.replace(/^\uFEFF/, ""));
  const header = table[0];
  if (!header) return { headers: [], rows: [], error: "The file is empty." };
  const headers = header.map((cell) => cell.trim().toLowerCase());
  const nameIndex = headers.indexOf("name");
  const phoneIndex = headers.indexOf("phone");
  const emailIndex = headers.indexOf("email");
  const notesIndex = headers.indexOf("notes");
  if (nameIndex < 0 || phoneIndex < 0 || emailIndex < 0 || notesIndex < 0) {
    return { headers, rows: [], error: "The file needs name, phone, email, and notes columns." };
  }
  const rows: CsvRow[] = [];
  for (let index = 1; index < table.length; index += 1) {
    const cells = table[index] ?? [];
    if (cells.every((cell) => cell.trim().length === 0)) continue;
    rows.push({
      line: index + 1,
      name: (cells[nameIndex] ?? "").trim(),
      phone: (cells[phoneIndex] ?? "").trim(),
      email: (cells[emailIndex] ?? "").trim(),
      notes: (cells[notesIndex] ?? "").trim(),
    });
  }
  if (rows.length > CUSTOMER_IMPORT_MAX_ROWS) {
    return {
      headers,
      rows: [],
      error: `The file has ${rows.length} rows. Import at most ${CUSTOMER_IMPORT_MAX_ROWS} rows at a time; split the file and import each part.`,
    };
  }
  return { headers, rows };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char ?? "";
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char ?? "";
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
