import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ThemeProvider, ToastProvider, themeBootScript } from "@bizora/ui";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { AdminShell } from "@/components/admin-shell";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("portal"), robots: { index: false, follow: false } };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const messages = await getMessages();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // Shown on every screen outside production, so nobody mistakes test data for real shops.
  const environment = process.env.BIZORA_ENVIRONMENT ?? "development";
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="bg-canvas text-fg">
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <NextIntlClientProvider locale="en" messages={messages}>
          <ThemeProvider>
            <ToastProvider>
              <AdminShell environment={environment}>{children}</AdminShell>
            </ToastProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
