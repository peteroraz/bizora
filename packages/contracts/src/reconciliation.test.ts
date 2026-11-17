import { describe, expect, it } from "vitest";
import { matchColumns, rowsFromCsv } from "./csv.js";
import { reconcileSchema, STATEMENT_IMPORT_COLUMNS, statementImportSchema } from "./reconciliation.js";

describe("bank statements", () => {
  it("reads the column names banks use", () => {
    // GTBank / Access style
    expect(matchColumns(["Trans. Date", "Value Date", "Narration", "Reference", "Debits", "Credits", "Balance"], STATEMENT_IMPORT_COLUMNS)).toMatchObject({
      description: 2,
      reference: 3,
      moneyOut: 4,
      moneyIn: 5,
    });
    // Moniepoint / Opay style
    expect(matchColumns(["Date", "Description", "Money In", "Money Out"], STATEMENT_IMPORT_COLUMNS)).toEqual({ date: 0, description: 1, moneyIn: 2, moneyOut: 3 });
    // Our own template
    const header = Object.keys(STATEMENT_IMPORT_COLUMNS);
    const { rows } = rowsFromCsv(`${["Date", "Description", "Reference", "Money in", "Money out"].join(",")}\n16/11/2026,NIP CR,S1,"15,000.00",\n`, STATEMENT_IMPORT_COLUMNS);
    expect(header).toEqual(["date", "description", "reference", "moneyIn", "moneyOut"]);
    expect(rows[0]).toMatchObject({ date: "16/11/2026", description: "NIP CR", reference: "S1", moneyIn: "15,000.00", moneyOut: "" });
  });

  it("checks what a line can be matched to", () => {
    expect(statementImportSchema.safeParse({ accountLabel: "", rows: [] }).success).toBe(false);
    expect(reconcileSchema.safeParse({ target: { kind: "own_transfer", source: "pos_settlement" } }).success).toBe(true);
    expect(reconcileSchema.safeParse({ target: { kind: "money_in", category: "salary" } }).success).toBe(false);
    expect(reconcileSchema.safeParse({ target: { kind: "ignored", reason: " " } }).success).toBe(false);
  });
});
