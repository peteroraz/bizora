import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { loadReceipt, ReceiptView } from "../../../components/public-receipt";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** The short link from before 6e. It still works, and moves to the business's own link when it has one (ADR-024). */
export default async function ShortReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const receipt = await loadReceipt(token);
  if (!receipt) notFound();
  if (receipt.handle) redirect(`/${receipt.handle}/r/${token}`);
  return <ReceiptView token={token} receipt={receipt} />;
}
