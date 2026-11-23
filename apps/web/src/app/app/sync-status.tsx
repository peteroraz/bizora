"use client";

import { Badge, Button } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type Owner = { tenantId: string; membershipId: string };

/**
 * Waiting sales and the sample-business note. Loaded after the screen has opened so it is not part of the
 * JavaScript every screen needs first (the quick sale is at its script limit).
 */
export function SyncStatus({ owner, isSample, buttonHost }: { owner: Owner | null; isSample: boolean; buttonHost: HTMLElement | null }) {
  const t = useTranslations("shell");
  const [outbox, setOutbox] = useState<{ pending: number; retrying: number; rejected: { id: string; error: { message: string } | null; meta?: { summary: string } }[] }>({
    pending: 0,
    retrying: 0,
    rejected: [],
  });

  // Send work saved offline whenever the device is online, and show what is still waiting.
  useEffect(() => {
    if (!owner) return;
    const scoped = { tenantId: owner.tenantId, membershipId: owner.membershipId };
    let stopped = false;
    let cleanup = () => undefined as void;
    void Promise.all([import("../../lib/offline/outbox"), import("../../lib/offline/sync")]).then(([queue, sync]) => {
      if (stopped) return;
      const refresh = () => {
        void queue
          .summary(scoped)
          .then((next) => setOutbox({ pending: next.pending, retrying: next.retrying, rejected: next.rejected }))
          .catch(() => undefined);
      };
      refresh();
      const unsubscribe = queue.subscribe(refresh);
      const stop = sync.startBackgroundSync(scoped);
      cleanup = () => {
        unsubscribe();
        stop();
      };
    });
    return () => {
      stopped = true;
      cleanup();
    };
  }, [owner]);

  const button =
    outbox.pending > 0 ? (
      // Tapping tries again at once (ADR-044); after a failed try it says so, so nobody thinks it synced.
      <button
        type="button"
        data-testid="sync-now"
        className="min-h-9 rounded-full"
        onClick={() => owner && void Promise.all([import("../../lib/offline/outbox"), import("../../lib/offline/sync")]).then(([queue, sync]) => queue.flush(owner, sync.pushToServer, Date.now(), { force: true }))}
      >
        <Badge tone="warning" role="status">
          {outbox.retrying > 0 ? t("syncRetrying", { count: outbox.pending }) : t("syncWaiting", { count: outbox.pending })}
        </Badge>
      </button>
    ) : null;

  return (
    <>
      {button && buttonHost ? createPortal(button, buttonHost) : null}
      {outbox.rejected.length > 0 && owner ? (
        <div className="flex flex-wrap items-start gap-3 border-b border-border bg-card px-4 py-3 text-sm" role="alert">
          <div className="flex-1">
            <p className="font-medium text-danger">{t("syncRejected", { count: outbox.rejected.length })}</p>
            <ul className="mt-1 list-disc pl-5 text-muted">
              {outbox.rejected.map((item) => (
                <li key={item.id}>{item.meta?.summary ? `${item.meta.summary}: ` : ""}{item.error?.message}</li>
              ))}
            </ul>
          </div>
          <Button variant="secondary" onClick={() => void import("../../lib/offline/outbox").then((queue) => queue.dismissRejected(owner))}>
            {t("syncDismiss")}
          </Button>
        </div>
      ) : null}
      {isSample ? (
        <p className="border-b border-info bg-info-bg px-4 py-2 text-sm text-info" role="note" data-testid="sample-banner">
          {t("sampleBusiness")}
        </p>
      ) : null}
    </>
  );
}
