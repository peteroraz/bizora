// No zod here: the quick sale page needs these numbers without loading the sync schemas.
/** Official numbers per business and document type, issued by the server in order. */
export const DOCUMENT_PREFIXES = {
  receipt: "R",
  invoice: "INV",
  payment: "PAY",
  stock_in: "SI",
  stock_count: "SC",
  stock_transfer: "TR",
  expense: "EXP",
  sale_return: "RET",
  supplier_return: "SR",
  job: "JOB",
} as const;
export type DocumentType = keyof typeof DOCUMENT_PREFIXES;

export function formatOfficialNumber(type: DocumentType, value: bigint | number): string {
  return `${DOCUMENT_PREFIXES[type]}-${value.toString().padStart(6, "0")}`;
}

/** A number a shop device gives a document while offline, e.g. DEV3-000045. The device number is unique per organization. */
export function provisionalNumber(deviceCode: number, sequence: number): string {
  return `DEV${deviceCode}-${sequence.toString().padStart(6, "0")}`;
}
