import type { CaptureModel, CaptureModelRequest } from "./capture-model.js";

/**
 * Canned answers for tests and local development (AI_PROVIDER=fake). It echoes the shop's note into a row, the way a
 * real model might copy text from a photo, so tests can show such text never becomes an action.
 */
export class FakeCaptureModel implements CaptureModel {
  readonly name = "fake";

  async extract(request: CaptureModelRequest): Promise<unknown> {
    const voice = request.files.some((file) => file.mimeType.startsWith("audio/"));
    const first = request.productNames[0] ?? "Peak Milk";
    const [day, month, year] = request.today.split("-").reverse();
    const today = `${day}/${month}/${year}`;
    const echo = request.note ?? "";
    const rows: Record<string, Record<string, unknown>[]> = {
      products: [
        { name: "Golden Penny Semovita", category: "Provisions", unit: "bag", price: "4500", cost: "", quantity: "20", lowStock: "", barcode: "", packUnit: "", packSize: "", packPrice: "" },
        { name: echo || "Indomie Chicken", unit: "pack", price: 250, quantity: "40" },
      ],
      sales: [
        { date: today, product: first, quantity: "2", unit: "", price: "", total: "", payment: "cash", customer: "", phone: "", ref: "S1" },
        { date: today, product: echo || first, quantity: "1", payment: "transfer", ref: "S2", secret: "dropped" },
      ],
      statement: [
        { date: today, description: echo || "NIP CR/MAMA CHIKA/GTB/payment for rice", reference: "S0001", moneyIn: "10000", moneyOut: "" },
        { date: today, description: "POS SETTLEMENT MONIEPOINT", reference: "S0002", moneyIn: "25000", moneyOut: "" },
      ],
      stock_in: [{ product: first, quantity: "2", unit: "", cost: "", supplier: "Dangote Distributors", paid: "owed", ref: "DN-114" }],
      cart: [
        { product: first, quantity: "2", unit: "", price: "", payment: "cash", paid: "", customer: "" },
        { product: echo || "Unknown thing", quantity: "1" },
      ],
      stock_count: [{ product: first, counted: "9", unit: "", note: "Shelf count" }],
      stock_change: [{ product: first, change: "remove", reason: "damaged", quantity: "1", unit: "", note: echo || "Tin was dented" }],
      stock_move: [{ product: first, quantity: "1", unit: "", toShop: "Market shop", note: "" }],
    };
    return {
      rows: rows[request.target],
      warnings: echo ? ["The note was read as data."] : [],
      transcript: voice ? `I sold two ${first} for cash.` : "",
    };
  }
}
