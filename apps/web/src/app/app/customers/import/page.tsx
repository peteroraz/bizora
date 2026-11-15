"use client";

import { Permission } from "@bizora/contracts";
import { FormField, Input, PageHeader, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { RequireAccess } from "../../../../components/require-access";
import { api } from "../../../../lib/api";

type PreviewRow = {
  line: number;
  name: string;
  phone: string;
  phoneE164: string | null;
  action: "create" | "update" | "error";
  errors: string[];
};

function ImportCustomersPageScreen() {
  const t = useTranslations("customers");
  const [csv, setCsv] = useState("");
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const commit = useRef(false);

  function rowError(message: string) {
    if (message.startsWith("Name")) return t("errorName");
    if (message.startsWith("Email")) return t("errorEmail");
    if (message.startsWith("Phone")) return t("errorPhone");
    if (message.includes("another shop")) return t("errorShop");
    return message;
  }

  async function submit() {
    const saving = commit.current;
    commit.current = false;
    setPending(true);
    setError(null);
    setNotice(null);
    const response = await api("/api/v1/customers/import", {
      method: "POST",
      body: JSON.stringify({ csv, commit: saving }),
    });
    const payload = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(payload?.error?.code === "CSV_INVALID" ? t("csvInvalid") : (payload?.error?.message ?? t("previewFailed")));
      return;
    }
    setRows(payload.data?.rows ?? []);
    if (saving) setNotice(t("imported", { created: payload.data?.created ?? 0, updated: payload.data?.updated ?? 0 }));
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("importTitle")} description={t("importLead")} />
      <SafeForm className="space-y-4" pending={pending} onSubmit={submit}>
        <FormField id="csv-file" label={t("file")}>
          <Input
            id="csv-file"
            type="file"
            accept=".csv,text/csv"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              setCsv(file ? await file.text() : "");
            }}
          />
        </FormField>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="text-sm text-muted">{notice}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Link href="/app/customers" className="text-sm font-medium text-muted">
            {t("back")}
          </Link>
          <SubmitButton
            pending={pending}
            pendingLabel={t("importing")}
            onClick={() => {
              commit.current = false;
            }}
            disabled={csv.trim().length === 0}
          >
            {t("preview")}
          </SubmitButton>
          <SubmitButton
            pending={pending}
            pendingLabel={t("importing")}
            variant="secondary"
            onClick={() => {
              commit.current = true;
            }}
            disabled={rows.length === 0 || rows.every((row) => row.action === "error")}
          >
            {t("importRows")}
          </SubmitButton>
        </div>
      </SafeForm>
      {rows.length > 0 ? (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.line} className="rounded-card border border-border bg-card px-4 py-3 text-sm">
              <p className="font-medium">{t("row", { line: row.line })}</p>
              <p>
                {row.name} · {row.phoneE164 || row.phone}
              </p>
              <p className="text-muted">
                {row.action === "create" ? t("willCreate") : row.action === "update" ? t("willUpdate") : t("rowError")}
              </p>
              {row.errors.map((item) => (
                <p key={item} className="text-danger">
                  {rowError(item)}
                </p>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function ImportCustomersPage() {
  return (
    <RequireAccess anyOf={[Permission.CUSTOMERS_MANAGE]}>
      <ImportCustomersPageScreen />
    </RequireAccess>
  );
}
