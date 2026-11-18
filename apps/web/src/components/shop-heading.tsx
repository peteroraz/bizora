import { buttonVariants } from "@bizora/ui";
import { getTranslations } from "next-intl/server";
import { formatPhone } from "../i18n/format";

/**
 * The top of a page a customer opens from WhatsApp (6d): the shop's logo, name, where it is, and buttons to call or
 * chat. `logoSrc` is a token-scoped address, so the page never reveals anything about the business's account.
 */
export async function ShopHeading({
  name,
  place,
  address,
  phone,
  logoSrc,
  color,
  profileHref,
}: {
  name: string;
  place?: string | null;
  address?: string | null;
  phone?: string | null;
  logoSrc?: string | null;
  /** The business's own colour (already checked readable on white), as a band across the top (6e). */
  color?: string | null;
  /** The business's own page, so the customer can see who sent this. */
  profileHref?: string | null;
}) {
  const t = await getTranslations("publicShop");
  const digits = phone?.replace(/\D/g, "") ?? "";
  return (
    <header className="space-y-3">
      {color ? <div className="-mx-6 -mt-6 mb-4 h-1.5" style={{ backgroundColor: color }} aria-hidden="true" /> : null}
      <div className="flex items-center gap-3">
        {logoSrc ? (
          // A plain image: customer pages stay light and work without the image service.
          <img src={logoSrc} alt="" className="h-12 max-w-24 shrink-0 object-contain" />
        ) : null}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">
            {profileHref ? (
              <a href={profileHref} className="hover:underline">
                {name}
              </a>
            ) : (
              name
            )}
          </h1>
          {place && place !== name ? <p className="text-sm text-muted">{place}</p> : null}
          {address ? <p className="text-sm text-muted">{address}</p> : null}
        </div>
      </div>
      {phone ? (
        <div className="flex flex-wrap gap-2">
          <a href={`tel:${phone}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("call", { phone: formatPhone(phone) })}
          </a>
          <a href={`https://wa.me/${digits}`} className={buttonVariants({ variant: "outline", size: "sm" })} rel="noreferrer" target="_blank">
            {t("whatsapp")}
          </a>
        </div>
      ) : null}
    </header>
  );
}

/** The owner's own words for the customer: thanks on a receipt, how to pay on an invoice or statement. */
export function ShopMessage({ title, text }: { title: string; text: string | null }) {
  if (!text) return null;
  return (
    <section className="rounded-card border border-border bg-card p-4" data-testid="shop-message">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-1 whitespace-pre-line text-sm">{text}</p>
    </section>
  );
}
