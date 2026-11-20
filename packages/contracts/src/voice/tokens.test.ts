import { describe, expect, it } from "vitest";
import { ENGLISH } from "./lexicon.js";
import { tokenize, type NumberToken } from "./tokens.js";

const numbers = (text: string) => tokenize(text, ENGLISH).filter((t): t is NumberToken => t.kind === "num").map((t) => t.value / 1000n);
const thousandths = (text: string) => tokenize(text, ENGLISH).filter((t): t is NumberToken => t.kind === "num").map((t) => t.value);

describe("spoken numbers", () => {
  it("reads number words exactly", () => {
    expect(numbers("five bags")).toEqual([5n]);
    expect(numbers("seventy-five thousand naira")).toEqual([75_000n]);
    expect(numbers("seventy five thousand")).toEqual([75_000n]);
    expect(numbers("three hundred thousand")).toEqual([300_000n]);
    expect(numbers("three hundred and fifty thousand")).toEqual([350_000n]);
    expect(numbers("one million two hundred thousand")).toEqual([1_200_000n]);
    expect(numbers("a hundred and twenty")).toEqual([120n]);
    expect(numbers("a thousand five hundred")).toEqual([1_500n]);
    expect(numbers("twelve thousand each")).toEqual([12_000n]);
    expect(numbers("nineteen")).toEqual([19n]);
  });

  it("reads digits, shorthand and symbols", () => {
    expect(numbers("₦75,000")).toEqual([75_000n]);
    expect(numbers("N75000")).toEqual([75_000n]);
    expect(numbers("#5000")).toEqual([5_000n]);
    expect(numbers("75k")).toEqual([75_000n]);
    expect(numbers("1.5m")).toEqual([1_500_000n]);
    expect(numbers("75 thousand")).toEqual([75_000n]);
    expect(numbers("seventy five k")).toEqual([75_000n]);
  });

  it("keeps fractions exact", () => {
    expect(thousandths("two point five kg")).toEqual([2_500n]);
    expect(thousandths("one and a half")).toEqual([1_500n]);
    expect(thousandths("half bag")).toEqual([500n]);
    expect(thousandths("2.25")).toEqual([2_250n]);
  });

  it("keeps separate numbers apart", () => {
    expect(numbers("five bags at seventy five thousand naira each")).toEqual([5n, 75_000n]);
    expect(numbers("paid three hundred thousand and will balance seventy five thousand")).toEqual([300_000n, 75_000n]);
    expect(numbers("three cartons twelve thousand each paid twenty thousand balance sixteen thousand")).toEqual([3n, 12_000n, 20_000n, 16_000n]);
  });

  it("marks what was said like money", () => {
    const tokens = tokenize("five bags 75k each, two crates ₦3,000 and ten dollars", ENGLISH).filter((t): t is NumberToken => t.kind === "num");
    expect(tokens.map((t) => [t.moneyHint, t.currency])).toEqual([
      [false, null],
      [true, null],
      [false, null],
      [true, "NGN"],
      [true, "USD"],
    ]);
  });
});
