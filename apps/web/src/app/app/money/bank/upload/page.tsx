"use client";

import { Permission, STATEMENT_IMPORT_COLUMNS, type StatementImportField } from "@bizora/contracts";
import { FormField, Input, PageHeader } from "@bizora/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { type ImportColumn, ImportReview } from "../../../../../components/import-review";
import { RequireAccess } from "../../../../../components/require-access";
import { BackLink } from "../../../../../components/action-link";

const FIELDS: StatementImportField[] = ["date", "description", "reference", "moneyIn", "moneyOut"];
const LABEL_KEY = "bizora.statementAccount";

const EXAMPLE: Record<StatementImportField, string> = { date: "16/11/2026", description: "", reference: "S0001", moneyIn: "15000", moneyOut: "" };

/** Upload a bank statement (CSV, or a PDF or photo read by the AI), check the lines, and add money in to the inbox. */
function UploadScreen() {
  const t = useTranslations("bank");
  const [account, setAccount] = useState("");
  const [added, setAdded] = useState<number | null>(null);

  useEffect(() => {
    try {
      setAccount(localStorage.getItem(LABEL_KEY) ?? "");
    } catch {
      // Storage can be unavailable; the field just starts empty.
    }
  }, []);

  const columns: ImportColumn<StatementImportField>[] = FIELDS.map((field) => ({ field, label: t(`columns.${field}`), wide: field === "description" }));
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("uploadTitle")}
        description={t("uploadLead")}
        actions={
          <BackLink href="/app/money/bank">{t("backToInbox")}</BackLink>
        }
      />
      <FormField id="statement-account" label={t("accountLabel")} hint={t("accountHint")}>
        <Input
          id="statement-account"
          value={account}
          maxLength={80}
          onChange={(event) => {
            setAccount(event.target.value);
            try {
              localStorage.setItem(LABEL_KEY, event.target.value);
            } catch {
              // Remembering the account name is a convenience only.
            }
          }}
        />
      </FormField>
      {added !== null ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {t("added", { count: added })}{" "}
          <Link href="/app/money/bank" className="font-medium underline">
            {t("openInbox")}
          </Link>
        </p>
      ) : null}
      <ImportReview
        columns={columns}
        synonyms={STATEMENT_IMPORT_COLUMNS}
        endpoint="/api/v1/imports/statement"
        extra={{ accountLabel: account.trim() }}
        templateName="bizora-bank-statement.csv"
        templateExample={{ ...EXAMPLE, description: t("exampleDescription") }}
        capture="statement"
        onSaved={(totals) => setAdded(totals.create)}
      />
    </div>
  );
}

export default function StatementUploadPage() {
  return (
    <RequireAccess anyOf={[Permission.BANK_RECONCILE]}>
      <UploadScreen />
    </RequireAccess>
  );
}
