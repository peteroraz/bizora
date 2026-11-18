import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { loadStatement, StatementView } from "../../../../components/public-statement";

type Params = { params: Promise<{ handle: string; token: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params;
  const statement = await loadStatement(token);
  const t = await getTranslations("statement");
  if (!statement) return { robots: { index: false, follow: false } };
  const title = t("shareTitle", { business: statement.businessName });
  return {
    title,
    description: t("shareDescription", { business: statement.businessName }),
    robots: { index: false, follow: false },
    openGraph: { title, description: t("shareDescription", { business: statement.businessName }), siteName: statement.businessName, type: "website" },
  };
}

/** A customer's statement at the business's own link: /<handle>/s/<token> (ADR-024). */
export default async function BusinessStatementPage({ params }: Params) {
  const { handle, token } = await params;
  const statement = await loadStatement(token);
  if (!statement) notFound();
  if (statement.handle && statement.handle !== handle) redirect(`/${statement.handle}/s/${token}`);
  return <StatementView token={token} statement={statement} />;
}
