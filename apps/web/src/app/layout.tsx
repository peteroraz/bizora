import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ThemeProvider, ToastProvider, themeBootScript, themeColor, themeColorDark } from "@bizora/ui";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("public");
  // Shared links need absolute addresses for their preview pictures; use the address the visitor came in on.
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return {
    metadataBase: new URL(`${protocol}://${host}`),
    title: "Bizora",
    description: t("lead"),
    manifest: "/manifest.webmanifest",
    applicationName: "Bizora",
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: themeColor },
    { media: "(prefers-color-scheme: dark)", color: themeColorDark },
  ],
  width: "device-width",
  initialScale: 1,
};

/**
 * Script errors in people's browsers are sent to the API (ADR-036): a few per page, links' tokens never included.
 * Inline so it adds nothing to any screen's JavaScript, and it runs before the app does.
 */
const errorReporterScript = `(function(){var n=0;function s(k,m,t){if(n++>4||!navigator.sendBeacon)return;try{navigator.sendBeacon('/api/v1/telemetry/client-errors',new Blob([JSON.stringify({kind:k,message:String(m||'').slice(0,500),stack:String(t||'').slice(0,4000),url:location.pathname})],{type:'application/json'}))}catch(e){}}addEventListener('error',function(e){if(e.error||e.message)s('error',e.message,e.error&&e.error.stack)});addEventListener('unhandledrejection',function(e){var r=e.reason;s('unhandledrejection',r&&r.message||r,r&&r.stack)})})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  // The content security policy's nonce for this page (ADR-036); set by the middleware.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang={locale} className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: errorReporterScript }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider>
            <ToastProvider>{children}</ToastProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js'); }`,
          }}
        />
      </body>
    </html>
  );
}
