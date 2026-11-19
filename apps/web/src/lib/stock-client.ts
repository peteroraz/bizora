import { api } from "./api";
import { type Catalog, type PullFn, readCatalog, refreshCatalog } from "./offline/catalog";

export type ProductView = {
  id: string;
  name: string;
  category: string | null;
  baseUnit: string;
  priceMinor: string | null;
  packs: { unitCode: string; baseQuantity: string; priceMinor: string | null }[];
  lowStockLevel: string | null;
  barcode: string | null;
  trackStock: boolean;
  archived?: boolean;
  defaultCostMinor?: string | null;
  stock: { quantity: string; belowZero: boolean; low?: boolean; valueMinor?: string };
  /** The main photo (ADR-033), when the product has one. */
  photoUrl?: string | null;
};

export const pullFromServer: PullFn = async (cursors) => {
  const params = new URLSearchParams();
  if (cursors.products) params.set("products", cursors.products);
  if (cursors.balances) params.set("balances", cursors.balances);
  const response = await api(`/api/v1/products/sync?${params.toString()}`);
  if (!response.ok) throw new Error(`Download failed with ${response.status}`);
  return (await response.json()).data;
};

/** Keeps the phone's copy of products and stock fresh; failures are ignored (the old copy stays). */
export async function refreshOfflineCatalog(tenantId: string | undefined, branchId: string | null | undefined): Promise<Catalog | null> {
  if (!tenantId || !branchId || typeof indexedDB === "undefined") return null;
  try {
    return await refreshCatalog(tenantId, branchId, pullFromServer);
  } catch {
    return readCatalog(tenantId, branchId).catch(() => null);
  }
}
