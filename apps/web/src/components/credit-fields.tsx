"use client";

import { Card, FormField } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { dayKey } from "../i18n/format";
import { DueDatePicker } from "./due-date-picker";
import { SentenceInput } from "./typing";

/** When money is still owed on a quick sale: the date it will be paid and why (loaded only then, ADR-041 budget). */
export default function CreditFields(props: { dueDate: string; comment: string; onDueDate: (value: string) => void; onComment: (value: string) => void }) {
  const t = useTranslations("sales");
  return (
    <Card className="p-4">
      <p className="text-sm font-medium">{t("creditTitle")}</p>
      <div className="mt-2 space-y-3">
        <FormField id="sale-due" label={t("dueDate")}>
          <DueDatePicker id="sale-due" value={props.dueDate} today={dayKey(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)} onChange={props.onDueDate} />
        </FormField>
        <FormField id="sale-credit-comment" label={t("creditComment")}>
          <SentenceInput id="sale-credit-comment" value={props.comment} maxLength={500} onChange={(event) => props.onComment(event.target.value)} />
        </FormField>
      </div>
    </Card>
  );
}
