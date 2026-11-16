"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

/** How many notifications are unread, checked every minute and when the app comes back to the screen. */
export function NotificationBell() {
  const t = useTranslations("notifications");
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let stopped = false;
    const check = () => {
      if (document.visibilityState !== "visible" || navigator.onLine === false) return;
      void api("/api/v1/notifications")
        .then(async (response) => {
          if (response.ok && !stopped) setUnread((await response.json()).data.unread);
        })
        .catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("bizora:notifications-read", check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("bizora:notifications-read", check);
    };
  }, []);

  return (
    <Link
      href="/app/notifications"
      aria-label={unread > 0 ? t("bellUnread", { count: unread }) : t("bell")}
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-control hover:bg-secondary"
    >
      <Bell className="h-4 w-4" aria-hidden="true" />
      {unread > 0 ? (
        <span className="absolute right-1 top-1 min-w-4 rounded-pill bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white" data-testid="notification-count">
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </Link>
  );
}
