"use client";

import { Permission, SALE_IMPORT_MODES, SALES_IMPORT_COLUMNS, type SalesImportField } from "@bizora/contracts";
import { Card, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type ImportColumn, ImportReview } from "../../../../components/import-review";
import { RequireAccess } from "../../../../components/require-access";

const EXAMPLE: Record<SalesImportField, string> = {
  date: "16/11/2026",
  product: "",
  quantity: "2",
  unit: "tin",
  price: "4500",
  total: "9000",
  payment: "cash",
  customer: "",
  phone: "",
  ref: "A1",
};

const FIELDS: SalesImportField[] = ["date", "product", "quantity", "unit", "price", "total", "payment", "customer", "phone", "ref"];

function SalesImportScreen() {
  const t = useTranslations("imports");
  const [mode, setMode] = useState<(typeof SALE_IMPORT_MODES)[number]>("mixed");
  const columns: ImportColumn<SalesImportField>[] = FIELDS.map((field) => ({ field, label: t(`salesColumns.${field}`), wide: field === "product" || field === "customer" }));
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("salesTitle")}
        description={t("salesLead")}
        actions={
          <Link href="/app/sales" className="text-sm font-medium text-primary">
            {t("backToSales")}
          </Link>
        }
      />
      <Card>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("modeQuestion")}</legend>
          {SALE_IMPORT_MODES.map((option) => (
            <label key={option} className="flex items-start gap-2 text-sm">
              <input type="radio" name="import-mode" value={option} checked={mode === option} onChange={() => setMode(option)} className="mt-1" />
              <span>
                <span className="block font-medium">{t(`mode.${option}`)}</span>
                <span className="block text-muted">{t(`modeHint.${option}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </Card>
      <ImportReview columns={columns} synonyms={SALES_IMPORT_COLUMNS} endpoint="/api/v1/imports/sales" extra={{ mode }} templateName="bizora-sales.csv" templateExample={{ ...EXAMPLE, product: t("exampleProduct") }} />
    </div>
  );
}

export default function SalesImportPage() {
  return (
    <RequireAccess anyOf={[Permission.SALES_CREATE]}>
      <SalesImportScreen />
    </RequireAccess>
  );
}
