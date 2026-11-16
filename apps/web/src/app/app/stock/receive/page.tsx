"use client";

import { Permission, STOCK_IN_IMPORT_COLUMNS, type StockInImportField } from "@bizora/contracts";
import { PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ImportColumn, ImportReview } from "../../../../components/import-review";
import { RequireAccess } from "../../../../components/require-access";

const FIELDS: StockInImportField[] = ["product", "quantity", "unit", "cost", "supplier", "paid", "ref"];

const EXAMPLE: Record<StockInImportField, string> = {
  product: "",
  quantity: "10",
  unit: "carton",
  cost: "250000",
  supplier: "",
  paid: "owed",
  ref: "DN-114",
};

/**
 * A supplier delivery: snap the invoice or delivery note, say what arrived, or upload a CSV; check the rows; save
 * them together (ADR-018).
 */
function DeliveryScreen() {
  const t = useTranslations("imports");
  const columns: ImportColumn<StockInImportField>[] = FIELDS.map((field) => ({ field, label: t(`stockInColumns.${field}`), wide: field === "product" || field === "supplier" }));
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("stockInTitle")}
        description={t("stockInLead")}
        actions={
          <Link href="/app/stock" className="text-sm font-medium text-primary">
            {t("backToStock")}
          </Link>
        }
      />
      <ImportReview
        columns={columns}
        synonyms={STOCK_IN_IMPORT_COLUMNS}
        endpoint="/api/v1/imports/stock-in"
        templateName="bizora-delivery.csv"
        templateExample={{ ...EXAMPLE, product: t("exampleProduct"), supplier: t("exampleSupplier") }}
        capture="stock_in"
      />
    </div>
  );
}

export default function DeliveryPage() {
  return (
    <RequireAccess anyOf={[Permission.STOCK_RECEIVE]}>
      <DeliveryScreen />
    </RequireAccess>
  );
}
