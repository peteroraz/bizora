/** Plain rules about shop staff, with no form schemas, so screens can use them without the phone rules. */

/**
 * Roles that can be given to shop staff created without email (PIN on an enrolled shop device).
 * UI labels (Addendum v1.2 §5): SALES = "Sales staff", INVENTORY = "Storekeeper",
 * CASHIER = "Cashier", EMPLOYEE = "Shop helper". Managers, accountants and owners sign in with
 * email or Google and are invited the normal way.
 */
export const STAFF_ROLES = ["SALES", "CASHIER", "INVENTORY", "EMPLOYEE"] as const;

/** Rejects PINs that are trivially guessed: all the same digit, or straight runs like 1234 / 9876. */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = pin.split("").map(Number);
  const ascending = digits.every((digit, index) => index === 0 || digit === ((digits[index - 1] ?? 0) + 1) % 10);
  const descending = digits.every((digit, index) => index === 0 || digit === ((digits[index - 1] ?? 0) + 9) % 10);
  return ascending || descending;
}
