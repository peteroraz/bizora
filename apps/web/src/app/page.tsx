import { buttonVariants, Card } from "@bizora/ui";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PublicFooter } from "../components/public-footer";

export default async function HomePage() {
  if ((await cookies()).get("bizora_session")?.value) redirect("/app");
  const t = await getTranslations("public");
  const pains = [t("painCustomers"), t("painDebt"), t("painStock"), t("painMoney")];
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-10 sm:px-6 sm:py-16">
      <p className="text-sm font-semibold tracking-[0.2em] text-primary">{t("kicker")}</p>
      <h1 className="mt-3 max-w-3xl text-3xl font-semibold leading-tight sm:text-5xl">{t("title")}</h1>
      <p className="mt-4 max-w-2xl text-base text-muted sm:text-lg">{t("lead")}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/register" className={buttonVariants()}>
          {t("create")}
        </Link>
        <Link href="/login" className={buttonVariants({ variant: "secondary" })}>
          {t("signIn")}
        </Link>
      </div>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {pains.map((pain) => (
          <Card key={pain}>
            <p className="text-sm">{pain}</p>
          </Card>
        ))}
      </div>
      <PublicFooter />
    </main>
  );
}
