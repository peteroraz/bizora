"use client";

import { IDEMPOTENCY_HEADER, uuidv7 } from "@bizora/contracts";
import { Card, FormField, Input, SafeForm, SubmitButton } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatWhen } from "../i18n/format";
import { api } from "../lib/api";
import type { SaleComment } from "../lib/sales-client";

/** Comments from the sales person, cashier and store keeper. They cannot be changed once written. */
export function SaleComments({ saleId, comments, onAdded }: { saleId: string; comments: SaleComment[]; onAdded: () => void }) {
  const t = useTranslations("sales");
  const roles = useTranslations("roles");
  const locale = useLocale();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!body.trim()) return;
    setError(null);
    setPending(true);
    const response = await api(`/api/v1/sales/${saleId}/comments`, {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: uuidv7() },
      body: JSON.stringify({ body: body.trim() }),
    }).catch(() => null);
    setPending(false);
    if (response?.ok) {
      setBody("");
      onAdded();
      return;
    }
    setError(response ? t("failed") : t("needsNetwork"));
  }

  return (
    <Card>
      <p className="text-sm font-medium">{t("commentsTitle")}</p>
      {comments.length === 0 ? <p className="mt-2 text-sm text-muted">{t("noComments")}</p> : null}
      <ul className="mt-2 space-y-3 text-sm">
        {comments.map((comment) => (
          <li key={comment.id}>
            <p>
              {comment.kind === "credit" ? <span className="mr-1 font-medium text-warning">{t("creditCommentLabel")}</span> : null}
              {comment.body}
            </p>
            <p className="text-xs text-muted">
              {[comment.byName, comment.role && roles.has(comment.role) ? roles(comment.role) : comment.role, formatWhen(comment.createdAt, locale, "Africa/Lagos")].filter(Boolean).join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      <SafeForm className="mt-3 flex flex-wrap items-end gap-2" pending={pending} onSubmit={() => void add()}>
        <FormField id="sale-new-comment" label={t("addComment")}>
          <Input id="sale-new-comment" value={body} maxLength={500} onChange={(event) => setBody(event.target.value)} />
        </FormField>
        <SubmitButton pending={pending} pendingLabel={t("saving")}>
          {t("postComment")}
        </SubmitButton>
      </SafeForm>
      {error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
