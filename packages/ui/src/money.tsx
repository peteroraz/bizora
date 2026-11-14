import { formatMoney } from "@bizora/money";

export function MoneyText({
  amountMinor,
  currency,
  locale,
}: {
  amountMinor: bigint;
  currency: string;
  locale?: string;
}) {
  return <span className="tabular-nums">{formatMoney(amountMinor, currency, locale)}</span>;
}
