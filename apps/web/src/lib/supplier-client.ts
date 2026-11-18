import type { SupplierEntryKind, SupplierPaidFrom } from "@bizora/contracts";

/** Shapes of the suppliers API (ADR-029). Amounts are whole minor units as strings. */

export type SupplierView = { id: string; name: string; phoneE164: string | null; notes: string | null; unnamed: boolean; archived: boolean };

export type SupplierRow = SupplierView & { owedMinor: string; overdueMinor: string; nextPayBy: string | null; lastBoughtAt: string | null };

export type SupplierList = { currency: string; today: string; owedMinor: string; overdueMinor: string; owing: number; items: SupplierRow[] };

export type SupplierEntry = {
  id: string;
  kind: SupplierEntryKind;
  amountMinor: string;
  entryDate: string;
  payBy: string | null;
  paidFrom: SupplierPaidFrom | null;
  note: string | null;
  status: "recorded" | "voided";
  voidReason: string | null;
  shop: string | null;
  by: string | null;
  product: string | null;
  quantity: string | null;
  unit: string | null;
  documentNumber: string | null;
  createdAt: string;
  canCancel: boolean;
};

export type SupplierDetail = {
  currency: string;
  today: string;
  supplier: SupplierView;
  owedMinor: string;
  overdueMinor: string;
  nextPayBy: string | null;
  entries: SupplierEntry[];
  paidDeliveries: { id: string; product: string; quantity: string; unit: string; valueMinor: string; paidFrom: string; documentNumber: string | null; occurredAt: string }[];
};
