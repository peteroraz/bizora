import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { loadReceipt, ReceiptView } from "../../../../components/public-receipt";

type Params = { params: Promise<{ handle: string; token: string }> };

/** WhatsApp and other apps show this title and the business's own card when the link is shared (6e). */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params;
  const receipt = await loadReceipt(token);
  const t = await getTranslations("receipt");
  if (!receipt) return { robots: { index: false, follow: false } };
  const number = receipt.number ?? receipt.invoiceNumber ?? "";
  const title = receipt.documents.includes("receipt") || receipt.status === "completed" ? t("shareTitleReceipt", { number, business: receipt.businessName }) : t("shareTitleInvoice", { number, business: receipt.businessName });
  return {
    title,
    description: t("shareDescription", { business: receipt.businessName }),
    robots: { index: false, follow: false },
    openGraph: { title, description: t("shareDescription", { business: receipt.businessName }), siteName: receipt.businessName, type: "website" },
  };
}

/** A receipt or invoice at the business's own link: /<handle>/r/<token> (ADR-024). */
export default async function BusinessReceiptPage({ params }: Params) {
  const { handle, token } = await params;
  const receipt = await loadReceipt(token);
  if (!receipt) notFound();
  // The address must name the business the receipt belongs to; an old or wrong name moves to the right one.
  if (receipt.handle && receipt.handle !== handle) redirect(`/${receipt.handle}/r/${token}`);
  return <ReceiptView token={token} receipt={receipt} />;
}
