/**
 * Re-exports only. With "sideEffects": false, the web bundle keeps just the modules a page actually uses
 * (ADR-014: JavaScript budget), so importing Permission does not pull in phone numbers or geography.
 */
export { passwordRules, passwordSchema } from "./password.js";
export {
  PIN_LOCKOUT,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  STAFF_ROLES,
  createStaffSchema,
  enrollDeviceSchema,
  isWeakPin,
  pinLoginSchema,
  pinSchema,
  planFeatureSchema,
  planLimitSchema,
  planLimitsSchema,
  resetStaffPinSchema,
  staffRoleSchema,
} from "./staff.js";
export type { PlanFeature, PlanLimit, PlanLimits, StaffRole } from "./staff.js";
export { addressInputSchema, countryRule, formatAddressDisplay, optionalPhoneSchema, phoneE164Schema } from "./address.js";
export type { AddressDisplay, AddressInput } from "./address.js";
export { normalizePhoneToE164, whatsAppHref } from "./phone.js";
export {
  CUSTOMER_IMPORT_MAX_ROWS,
  CUSTOMER_PAGE_SIZE,
  customerImportSchema,
  customerNoteSchema,
  customerWriteSchema,
  customerClientIdSchema,
  customerCreditSchema,
  followupCreateSchema,
  followupUpdateSchema,
  parseCustomerCsv,
} from "./customers.js";
export type { CsvRow } from "./customers.js";
export {
  ALWAYS_VISIBLE_MODULES,
  TRADER_MODULES,
  businessTypeFromIndustry,
  businessTypeSchema,
  deriveTraderSetup,
  industryForBusinessType,
  staffCountBandSchema,
  traderModuleSchema,
} from "./trader.js";
export type { BusinessType, StaffCountBand, TraderModule } from "./trader.js";
export { Permission } from "./permissions.js";
export { uuidv7, isUuidV7, uuidv7Time } from "./ids.js";
export * from "./sync.js";
export * from "./ledger.js";
export * from "./stock.js";
export * from "./sales.js";
export * from "./csv.js";
export type { PermissionCode } from "./permissions.js";
export { ROLE_PERMISSIONS, LOOKUP_RESULT_LIMIT, LOOKUP_MIN_QUERY } from "./access.js";
export * from "./identity.js";
export * from "./capture.js";
export * from "./debtors.js";
export * from "./reconciliation.js";
export * from "./branding.js";
