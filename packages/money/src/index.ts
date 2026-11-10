import { Decimal } from "decimal.js";

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

const ISO_4217 = /^[A-Z]{3}$/;

export type Money = {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
};

export type ConvertedMoney = Money & {
  readonly baseAmountMinor: bigint;
  readonly baseCurrencyCode: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
};

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

function assertCurrency(code: string): string {
  const normalized = code.toUpperCase();
  if (!ISO_4217.test(normalized)) {
    throw new MoneyError(`Invalid ISO 4217 currency code: ${code}`);
  }
  return normalized;
}

export function money(amountMinor: bigint, currencyCode: string): Money {
  if (typeof amountMinor !== "bigint") {
    throw new MoneyError("Money amounts must use bigint minor units, never floating point");
  }
  return Object.freeze({
    amountMinor,
    currencyCode: assertCurrency(currencyCode),
  });
}

export function fromMinorNumber(amountMinor: number, currencyCode: string): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new MoneyError("Minor units must be whole integers");
  }
  return money(BigInt(amountMinor), currencyCode);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currencyCode !== b.currencyCode) {
    throw new MoneyError(`Currency mismatch: ${a.currencyCode} vs ${b.currencyCode}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currencyCode);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currencyCode);
}

export function allocate(total: Money, ratios: readonly number[]): Money[] {
  if (ratios.length === 0) {
    throw new MoneyError("At least one allocation ratio is required");
  }
  if (ratios.some((ratio) => !Number.isInteger(ratio) || ratio < 0)) {
    throw new MoneyError("Allocation ratios must be non-negative integers");
  }
  const ratioSum = ratios.reduce((sum, ratio) => sum + ratio, 0);
  if (ratioSum === 0) {
    throw new MoneyError("Allocation ratios must sum to a positive integer");
  }
  const parts: Money[] = [];
  let remainder = total.amountMinor;
  for (let i = 0; i < ratios.length; i += 1) {
    const ratio = ratios[i] ?? 0;
    const share =
      i === ratios.length - 1
        ? remainder
        : (total.amountMinor * BigInt(ratio)) / BigInt(ratioSum);
    remainder -= share;
    parts.push(money(share, total.currencyCode));
  }
  return parts;
}

export function convert(
  source: Money,
  baseCurrencyCode: string,
  fxRate: string,
  fxRateDate: string,
): ConvertedMoney {
  const rate = new Decimal(fxRate);
  if (!rate.isFinite() || rate.lte(0)) {
    throw new MoneyError("FX rate must be a positive decimal string");
  }
  const converted = new Decimal(source.amountMinor.toString()).mul(rate);
  const baseAmountMinor = BigInt(converted.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toFixed(0));
  return Object.freeze({
    ...source,
    baseAmountMinor,
    baseCurrencyCode: assertCurrency(baseCurrencyCode),
    fxRate: rate.toFixed(10),
    fxRateDate,
  });
}

export function serializeMoney(value: Money): { amountMinor: string; currencyCode: string } {
  return {
    amountMinor: value.amountMinor.toString(),
    currencyCode: value.currencyCode,
  };
}
