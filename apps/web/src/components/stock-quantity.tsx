"use client";

import { quantityToString, splitIntoPacks } from "@bizora/contracts";
import { useTranslations } from "next-intl";

export type PackView = { unitCode: string; baseQuantity: string };

/** "3 cartons, 4 pieces": a quantity in thousandths of the base unit, shown in the biggest packs first. */
export function useStockText() {
  const units = useTranslations("units");
  return (quantity: string, baseUnit: string, packs: PackView[] = []) =>
    splitIntoPacks(
      BigInt(quantity),
      baseUnit,
      packs.map((pack) => ({ unitCode: pack.unitCode, baseQuantity: BigInt(pack.baseQuantity) })),
    )
      .map((part) => {
        const amount = quantityToString(part.quantity);
        const label = units.has(part.unitCode) ? units(part.unitCode, { count: Math.abs(Number(amount)) }) : part.unitCode;
        return `${amount} ${label}`;
      })
      .join(", ");
}

/** The name of a unit for labels and menus ("pieces", "bags"). */
export function useUnitName() {
  const units = useTranslations("units");
  return (unit: string, count = 2) => (units.has(unit) ? units(unit, { count }) : unit);
}
