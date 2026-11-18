"use client";

import { Permission, STOCK_IN_IMPORT_COLUMNS, type StockInImportField } from "@bizora/contracts";
import { PageHeader } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { type ImportColumn, ImportReview } from "../../../../components/import-review";
import { RequireAccess } from "../../../../components/require-access";
import { BackLink } from "../../../../components/action-link";

/** What each column takes as it is edited (ADR-027). */
const STOCK_IN_KINDS: Partial<Record<StockInImportField, ImportColumn<StockInImportField>["kind"]>> = { quantity: "quantity", cost: "amount", supplier: "name" };

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
  const columns: ImportColumn<StockInImportField>[] = FIELDS.map((field) => ({ field, label: t(`stockInColumns.${field}`), wide: field === "product" || field === "supplier", kind: STOCK_IN_KINDS[field], sum: field === "cost" }));
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("stockInTitle")}
        description={t("stockInLead")}
        actions={
          <BackLink href="/app/stock">{t("backToStock")}</BackLink>
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
