"use client";

import {
  Permission,
  STOCK_CHANGE_IMPORT_COLUMNS,
  STOCK_COUNT_IMPORT_COLUMNS,
  STOCK_MOVE_IMPORT_COLUMNS,
  type StockChangeImportField,
  type StockCountImportField,
  type StockMoveImportField,
} from "@bizora/contracts";
import { PageHeader } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { type ImportColumn, ImportReview } from "../../../../components/import-review";
import { RequireAccess } from "../../../../components/require-access";
import { can } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";

type Kind = "count" | "change" | "move";

const COUNT_FIELDS: StockCountImportField[] = ["product", "counted", "unit", "note"];
const CHANGE_FIELDS: StockChangeImportField[] = ["product", "change", "reason", "quantity", "unit", "note"];
const MOVE_FIELDS: StockMoveImportField[] = ["product", "quantity", "unit", "toShop", "note"];

/**
 * Stock lists by voice, photo or file (ADR-033): say "five cartons of Indomie got wet", snap a count sheet, or forward a
 * WhatsApp voice note. The rows are checked here, against what is on the shelf, before anything is saved.
 */
function ListsScreen() {
  const t = useTranslations("stockLists");
  const access = useAccess();
  const kinds = (["count", "change", "move"] as const).filter((kind) =>
    kind === "count" ? can(access, Permission.STOCK_COUNT) : kind === "change" ? can(access, Permission.STOCK_ADJUST, Permission.STOCK_COUNT) : can(access, Permission.STOCK_TRANSFER),
  );
  const [kind, setKind] = useState<Kind>(kinds[0] ?? "count");
  const label = (field: string) => t(`columns.${field}`);
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("lead")} actions={<BackLink href="/app/stock">{t("back")}</BackLink>} />
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("which")}>
        {kinds.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={kind === option}
            className={`min-h-11 rounded-control border px-4 text-sm font-medium ${kind === option ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
            onClick={() => setKind(option)}
          >
            {t(`kinds.${option}`)}
          </button>
        ))}
      </div>
      <p className="text-sm text-muted">{t(`explain.${kind}`)}</p>
      {kind === "count" ? (
        <ImportReview
          key="count"
          columns={COUNT_FIELDS.map((field): ImportColumn<StockCountImportField> => ({ field, label: label(field), wide: field === "product" || field === "note", kind: field === "counted" ? "quantity" : field === "note" ? "text" : undefined }))}
          synonyms={STOCK_COUNT_IMPORT_COLUMNS}
          endpoint="/api/v1/imports/stock-count"
          templateName="bizora-count.csv"
          templateExample={{ product: t("exampleProduct"), counted: "12", unit: "carton", note: "" }}
          capture="stock_count"
        />
      ) : kind === "change" ? (
        <ImportReview
          key="change"
          columns={CHANGE_FIELDS.map((field): ImportColumn<StockChangeImportField> => ({ field, label: label(field), wide: field === "product" || field === "note", kind: field === "quantity" ? "quantity" : field === "note" ? "text" : undefined }))}
          synonyms={STOCK_CHANGE_IMPORT_COLUMNS}
          endpoint="/api/v1/imports/stock-change"
          templateName="bizora-stock-changes.csv"
          templateExample={{ product: t("exampleProduct"), change: "remove", reason: "damaged", quantity: "2", unit: "carton", note: t("exampleNote") }}
          capture="stock_change"
        />
      ) : (
        <ImportReview
          key="move"
          columns={MOVE_FIELDS.map((field): ImportColumn<StockMoveImportField> => ({ field, label: label(field), wide: field === "product" || field === "toShop" || field === "note", kind: field === "quantity" ? "quantity" : field === "note" ? "text" : field === "toShop" ? "name" : undefined }))}
          synonyms={STOCK_MOVE_IMPORT_COLUMNS}
          endpoint="/api/v1/imports/stock-move"
          templateName="bizora-stock-moves.csv"
          templateExample={{ product: t("exampleProduct"), quantity: "5", unit: "carton", toShop: t("exampleShop"), note: "" }}
          capture="stock_move"
        />
      )}
    </div>
  );
}

export default function StockListsPage() {
  return (
    <RequireAccess anyOf={[Permission.STOCK_COUNT, Permission.STOCK_ADJUST, Permission.STOCK_TRANSFER]}>
      <ListsScreen />
    </RequireAccess>
  );
}
