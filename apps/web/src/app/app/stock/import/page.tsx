"use client";

import { PRODUCT_IMPORT_COLUMNS, Permission, type ProductImportField } from "@bizora/contracts";
import { PageHeader } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { type ImportColumn, ImportReview } from "../../../../components/import-review";
import { RequireAccess } from "../../../../components/require-access";
import { can } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";
import { BackLink } from "../../../../components/action-link";
import { ProductFileDownload } from "../../../../components/product-file-download";

/** What each column takes as it is edited (ADR-027). */
const PRODUCT_KINDS: Partial<Record<ProductImportField, ImportColumn<ProductImportField>["kind"]>> = {
  name: "text",
  category: "text",
  price: "amount",
  cost: "amount",
  packPrice: "amount",
  quantity: "quantity",
  lowStock: "quantity",
  packSize: "quantity",
  brand: "text",
  item: "text",
  variant: "text",
  supplier: "text",
  priceListPrice: "amount",
};

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
  sku: "PK-400",
  gtin: "",
  brand: "Peak",
  item: "",
  variant: "",
  packForSale: "yes",
  packForPurchase: "yes",
  supplier: "",
  supplierCode: "",
  priceList: "",
  priceListPrice: "",
};

function ProductImportScreen() {
  const t = useTranslations("imports");
  const access = useAccess();
  const seeCost = can(access, Permission.PRICES_COST_READ);
  // The columns a product file can have (ADR-065). Suppliers and price lists only for those who manage them.
  const fields: ProductImportField[] = [
    "name",
    "item",
    "variant",
    "sku",
    "gtin",
    "barcode",
    "brand",
    "category",
    "unit",
    "price",
    ...(seeCost ? (["cost"] as const) : []),
    "quantity",
    "lowStock",
    "packUnit",
    "packSize",
    "packPrice",
    "packForSale",
    "packForPurchase",
    ...(can(access, Permission.PURCHASES_MANAGE) ? (["supplier", "supplierCode"] as const) : []),
    ...(can(access, Permission.PRICING_LISTS_MANAGE) ? (["priceList", "priceListPrice"] as const) : []),
  ];
  const columns: ImportColumn<ProductImportField>[] = fields.map((field) => ({ field, label: t(`productColumns.${field}`), wide: field === "name" || field === "category", kind: PRODUCT_KINDS[field] }));
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("productsTitle")}
        description={t("productsLead")}
        actions={
          <BackLink href="/app/stock">{t("backToStock")}</BackLink>
        }
      />
      <div className="space-y-1">
        <p className="text-sm text-muted">{t("downloadLead")}</p>
        <ProductFileDownload />
      </div>
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
