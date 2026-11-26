"use client";

import { Button, Dialog, FormField, Textarea, useToast } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { AdminApiError } from "@/lib/admin-api";

/**
 * Every support action asks why. The reason goes into the staff log and the business's own log (ADR-037).
 */
export function ReasonDialog({
  title,
  description,
  done,
  trigger,
  onConfirm,
  danger = false,
  children,
}: {
  title: string;
  description: string;
  done: string;
  trigger: ReactNode;
  onConfirm: (reason: string) => Promise<void>;
  danger?: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations("reason");
  const errors = useTranslations("errors");
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function confirm() {
    setWorking(true);
    setProblem(null);
    try {
      await onConfirm(reason.trim());
      toast.push(done, "success");
      setOpen(false);
      setReason("");
    } catch (error) {
      if (error instanceof AdminApiError) {
        // A fresh sign-in or a second person (ADR-071) is something the staff member can act on, so say it plainly.
        const actionable = error.code === "SIGN_IN_AGAIN" || error.code === "SECOND_PERSON_NEEDED";
        setProblem(error.fields.find((field) => field.field === "reason")?.message ?? (error.status === 403 && !actionable ? errors("notAllowed") : error.message || errors("generic")));
      } else {
        setProblem(errors("generic"));
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setProblem(null);
      }}
      title={title}
      description={description}
      trigger={trigger}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        {children}
        <FormField id="admin-reason" label={t("label")} hint={t("hint")} {...(problem ? { error: problem } : {})}>
          <Textarea
            id="admin-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("placeholder")}
            maxLength={500}
            aria-invalid={problem ? true : undefined}
            required
            minLength={5}
          />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} disabled={working || reason.trim().length < 5}>
            {working ? t("working") : t("confirm")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
