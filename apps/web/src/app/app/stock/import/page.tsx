"use client";

import { PRODUCT_IMPORT_COLUMNS, Permission, type ProductImportField } from "@bizora/contracts";
import { PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ImportColumn, ImportReview } from "../../../../components/import-review";
import { RequireAccess } from "../../../../components/require-access";
import { can } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";

const EXAMPLE: Record<ProductImportField, string> = {
  name: "",
  category: "Provisions",
  unit: "tin",
  price: "4500",
  cost: "3800",
  quantity: "48",
  lowStock: "12",
  barcode: "",
  packUnit: "carton",
  packSize: "24",
  packPrice: "105000",
};

function ProductImportScreen() {
  const t = useTranslations("imports");
  const access = useAccess();
  const seeCost = can(access, Permission.PRICES_COST_READ);
  const fields: ProductImportField[] = ["name", "category", "unit", "price", ...(seeCost ? (["cost"] as const) : []), "quantity", "lowStock", "barcode", "packUnit", "packSize", "packPrice"];
  const columns: ImportColumn<ProductImportField>[] = fields.map((field) => ({ field, label: t(`productColumns.${field}`), wide: field === "name" || field === "category" }));
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("productsTitle")}
        description={t("productsLead")}
        actions={
          <Link href="/app/stock" className="text-sm font-medium text-primary">
            {t("backToStock")}
          </Link>
        }
      />
      <ImportReview columns={columns} synonyms={PRODUCT_IMPORT_COLUMNS} endpoint="/api/v1/imports/products" templateName="bizora-products.csv" templateExample={{ ...EXAMPLE, name: t("exampleProduct") }} capture="products" />
    </div>
  );
}

export default function ProductImportPage() {
  return (
    <RequireAccess anyOf={[Permission.PRODUCTS_MANAGE]}>
      <ProductImportScreen />
    </RequireAccess>
  );
}
