import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { loadStatement, StatementView } from "../../../components/public-statement";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** The short link from before 6e. It still works, and moves to the business's own link when it has one (ADR-024). */
export default async function ShortStatementPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const statement = await loadStatement(token);
  if (!statement) notFound();
  if (statement.handle) redirect(`/${statement.handle}/s/${token}`);
  return <StatementView token={token} statement={statement} />;
}
