"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

export function PublicFooter() {
  const t = useTranslations("footer");
  return (
    <footer className="mt-10 flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted">
      <Link href="/privacy" className="font-medium text-primary">
        {t("privacy")}
      </Link>
      <Link href="/terms" className="font-medium text-primary">
        {t("terms")}
      </Link>
      <Link href="/login" className="font-medium text-primary">
        {t("signIn")}
      </Link>
      <Link href="/register" className="font-medium text-primary">
        {t("register")}
      </Link>
    </footer>
  );
}
