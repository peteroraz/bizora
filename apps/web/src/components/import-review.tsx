"use client";

import { IDEMPOTENCY_HEADER, IMPORT_MAX_ROWS, type ImportRowResult, rowsFromCsv, uuidv7 } from "@bizora/contracts";
import { Badge, Button, Card } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "../lib/api";

/**
 * The shared "check and edit before saving" screen (ADR-015). Rows come from a CSV file today; in Sprint 5b, photos
 * of handwritten books and voice notes will fill the same table as drafts. Nothing is saved until the server has
 * checked every row (a dry run), there are no errors left, and a person presses Save.
 */
export type ImportColumn<F extends string> = { field: F; label: string; wide?: boolean };

type Props<F extends string> = {
  columns: ImportColumn<F>[];
  synonyms: Record<F, readonly string[]>;
  endpoint: string;
  /** Sent with every check and save, such as the sales import mode. */
  extra?: Record<string, unknown>;
  templateName: string;
  templateExample: Record<F, string>;
  onSaved?: (totals: { create: number; update: number }) => void;
};

type Result = { committed: boolean; results: ImportRowResult[]; totals: { create: number; update: number; error: number } };

export function ImportReview<F extends string>({ columns, synonyms, endpoint, extra = {}, templateName, templateExample, onSaved }: Props<F>) {
  const t = useTranslations("imports");
  const [rows, setRows] = useState<Record<F, string>[]>([]);
  const [fileName, setFileName] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [checked, setChecked] = useState<Result | null>(null);
  const [checkedKey, setCheckedKey] = useState("");
  const [saved, setSaved] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blank = () => Object.fromEntries(columns.map((column) => [column.field, ""])) as Record<F, string>;
  const filled = rows.filter((row) => columns.some((column) => row[column.field].trim()));
  const key = JSON.stringify([filled, extra]);
  const upToDate = checked !== null && checkedKey === key;
  const canSave = upToDate && checked.totals.error === 0 && filled.length > 0;

  async function readFile(file: File) {
    setError(null);
    setSaved(null);
    setChecked(null);
    const text = await file.text();
    const parsed = rowsFromCsv(text, synonyms);
    setFileName(file.name);
    setMissing(columns.filter((column) => parsed.columns[column.field] === undefined).map((column) => column.label));
    if (parsed.rows.length > IMPORT_MAX_ROWS) {
      setError(t("tooMany", { max: IMPORT_MAX_ROWS }));
      setRows([]);
      return;
    }
    setRows(parsed.rows);
  }

  async function send(dryRun: boolean) {
    setError(null);
    setPending(true);
    try {
      const response = await api(endpoint, {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: uuidv7() },
        body: JSON.stringify({ ...extra, dryRun, rows: filled }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? t("failed"));
        return;
      }
      const result = payload.data as Result;
      if (dryRun || !result.committed) {
        setChecked(result);
        setCheckedKey(key);
      }
      if (!dryRun && result.committed) {
        setSaved(result);
        setRows([]);
        setChecked(null);
        onSaved?.(result.totals);
      }
    } catch {
      setError(t("offline"));
    } finally {
      setPending(false);
    }
  }

  function edit(index: number, field: F, value: string) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }

  // Results are numbered by position among the filled rows the server received.
  const resultFor = (index: number) => {
    if (!upToDate) return undefined;
    const position = filled.indexOf(rows[index] as Record<F, string>);
    return position < 0 ? undefined : checked.results.find((result) => result.row === position + 1);
  };

  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(
    `${columns.map((column) => column.label).join(",")}\n${columns.map((column) => csvCell(templateExample[column.field])).join(",")}\n`,
  )}`;

  return (
    <div className="space-y-4">
      {saved ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {t("saved", { create: saved.totals.create, update: saved.totals.update })}
        </p>
      ) : null}
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <label className="inline-flex cursor-pointer items-center rounded-control bg-primary px-4 py-2 text-sm font-medium text-primary-fg">
            {t("chooseFile")}
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label={t("chooseFile")}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
                event.target.value = "";
              }}
            />
          </label>
          <a href={template} download={templateName} className="text-sm text-primary">
            {t("template")}
          </a>
          <Button type="button" variant="ghost" onClick={() => setRows([...rows, blank()])}>
            {t("addRow")}
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted">{fileName ? t("fileRead", { name: fileName, count: rows.length }) : t("fileHint")}</p>
        {missing.length > 0 && fileName ? <p className="mt-1 text-sm text-muted">{t("missingColumns", { columns: missing.join(", ") })}</p> : null}
      </Card>
      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-card border border-border bg-card">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-2 py-2 font-medium">{t("rowNumber")}</th>
                {columns.map((column) => (
                  <th key={column.field} className="px-2 py-2 font-medium">
                    {column.label}
                  </th>
                ))}
                <th className="px-2 py-2 font-medium">{t("result")}</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const result = resultFor(index);
                const bad = new Set(result?.errors?.map((item) => item.field));
                return (
                  <tr key={index} className="border-b border-border align-top" data-testid={`import-row-${index + 1}`}>
                    <td className="px-2 py-1 text-muted">{index + 1}</td>
                    {columns.map((column) => (
                      <td key={column.field} className="px-1 py-1">
                        <input
                          aria-label={t("cell", { column: column.label, row: index + 1 })}
                          aria-invalid={bad.has(column.field) || undefined}
                          className={`w-full rounded-control border bg-background px-2 py-1 ${column.wide ? "min-w-40" : "min-w-20"} ${bad.has(column.field) ? "border-danger" : "border-border"}`}
                          value={row[column.field]}
                          onChange={(event) => edit(index, column.field, event.target.value)}
                        />
                      </td>
                    ))}
                    <td className="min-w-48 px-2 py-1">
                      {result ? (
                        <span className="space-y-1">
                          <Badge tone={result.status === "error" ? "danger" : result.status === "update" ? "info" : "success"}>{t(`status.${result.status}`)}</Badge>
                          {result.counts === false ? <Badge className="ml-1">{t("historyOnly")}</Badge> : null}
                          {result.message ? <span className="block text-xs text-muted">{result.message}</span> : null}
                          {result.errors?.map((item, i) => (
                            <span key={i} className="block text-xs text-danger">
                              {t("fieldError", { field: columns.find((column) => column.field === item.field)?.label ?? item.field, message: item.message })}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-1 py-1">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setRows(rows.filter((_, i) => i !== index))}>
                        {t("removeRow")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {upToDate ? (
        <p className="text-sm" role="status">
          {checked.totals.error > 0 ? t("checkedErrors", { count: checked.totals.error }) : t("checkedOk", { create: checked.totals.create, update: checked.totals.update })}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {filled.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="secondary" disabled={pending} onClick={() => void send(true)}>
            {pending ? t("working") : t("check")}
          </Button>
          <Button type="button" disabled={pending || !canSave} onClick={() => void send(false)}>
            {t("save", { count: filled.length })}
          </Button>
        </div>
      ) : null}
      {filled.length > 0 && !canSave ? <p className="text-xs text-muted">{t("saveHint")}</p> : null}
    </div>
  );
}

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
