/**
 * Re-exports only. With "sideEffects": false, the web bundle keeps just the modules a page actually uses
 * (ADR-014: JavaScript budget), so importing Permission does not pull in phone numbers or geography.
 */
export { passwordRules, passwordSchema } from "./password.js";
export {
  PIN_LOCKOUT,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  createStaffSchema,
  enrollDeviceSchema,
  pinLoginSchema,
  pinSchema,
  planFeatureSchema,
  planLimitSchema,
  planLimitsSchema,
  resetStaffPinSchema,
  staffRoleSchema,
} from "./staff.js";
export type { PlanFeature, PlanLimit, PlanLimits, StaffRole } from "./staff.js";
export { STAFF_ROLES, isWeakPin } from "./staff-roles.js";
export { addressInputSchema, countryRule, formatAddressDisplay, optionalPhoneSchema, phoneE164Schema } from "./address.js";
export type { AddressDisplay, AddressInput } from "./address.js";
export { checkPhone, normalizePhoneToE164, phoneProblemMessage, type PhoneCheck } from "./phone.js";
export { whatsAppHref } from "./whatsapp.js";
export {
  amountText,
  capitaliseFirst,
  capitaliseWords,
  caretAfterFormat,
  currencyDigits,
  parseAmount,
  parseAmountDigits,
  tidyEmail,
  tidyName,
  typeAmount,
  typeDigits,
  typeNumber,
} from "./typing.js";
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
export * from "./catalog.js";
export * from "./sales.js";
export * from "./csv.js";
export type { PermissionCode } from "./permissions.js";
export { ROLE_PERMISSIONS, LOOKUP_RESULT_LIMIT, LOOKUP_MIN_QUERY } from "./access.js";
export * from "./identity.js";
export * from "./capture.js";
export * from "./debtors.js";
export * from "./reconciliation.js";
export * from "./branding.js";
export * from "./handles.js";
export {
  CASH_FLOW_KINDS,
  EXPENSE_PAID_FROM,
  EXPENSE_STATUSES,
  MONEY_MOVEMENT_KINDS,
  MOVE_SCREEN_KINDS,
  posCashoutSchema,
  PROFIT_DAILY_MAX_DAYS,
  PROFIT_MAX_DAYS,
  cashCountSchema,
  expenseSchema,
  moneyMovementSchema,
  moneyReasonSchema,
  type CashCountInput,
  type CashFlowKind,
  type ExpenseInput,
  type ExpensePaidFrom,
  type ExpenseStatus,
  type MoneyMovementInput,
  type PosCashoutInput,
  type MoneyMovementKind,
} from "./money.js";
export {
  SUPPLIER_ENTRY_KINDS,
  SUPPLIER_PAID_FROM,
  UNNAMED_SUPPLIER,
  supplierOpeningSchema,
  supplierPaymentSchema,
  supplierSchema,
  supplierUpdateSchema,
  type SupplierEntryKind,
  type SupplierInput,
  type SupplierPaidFrom,
  type SupplierPaymentInput,
} from "./suppliers.js";
export {
  RETURN_REFUND_METHODS,
  SUPPLIER_RETURN_SETTLEMENTS,
  saleReturnSchema,
  supplierReturnSchema,
  type ReturnRefundMethod,
  type SaleReturnInput,
  type SupplierReturnInput,
  type SupplierReturnSettlement,
} from "./returns.js";
export {
  NOT_RECEIVED_AS,
  TRANSFER_CONFIRMATIONS,
  TRANSFER_KINDS,
  transferConfirmSchema,
  transferNotReceivedSchema,
  type NotReceivedAs,
  type TransferConfirmation,
  type TransferKind,
  type TransferNotReceivedInput,
} from "./transfers.js";
export {
  STOCK_REQUEST_KINDS,
  WEEKDAYS,
  WORK_PERMIT_MAX_HOURS,
  dayHoursSchema,
  hoursToday,
  isOpenAt,
  openingHoursSchema,
  setOpeningHoursSchema,
  shopLockSchema,
  stockRequestDecisionSchema,
  stockRequestRejectSchema,
  workPermitSchema,
} from "./work-rules.js";
export type { DayHours, OpeningHours, StockRequestKind, Weekday } from "./work-rules.js";
export {
  JOB_LINE_KINDS,
  JOB_MAX_DAYS_BACK,
  JOB_PAGE_SIZE,
  JOB_PAID_FROM,
  JOB_STATUSES,
  jobAddLinesSchema,
  jobCancelSchema,
  jobCreateSchema,
  jobFinishSchema,
  jobLineInputSchema,
  jobPayDaySchema,
  jobPaymentSchema,
  jobRemoveLineSchema,
  jobUpdateSchema,
} from "./jobs.js";
export type { JobCreateInput, JobLineInput, JobLineKind, JobPaidFrom, JobStatus } from "./jobs.js";
export {
  ADMIN_ABILITIES,
  ADMIN_ROLES,
  adminAbilities,
  adminCan,
  adminReasonSchema,
  adminRoleSchema,
  adminSearchSchema,
  adminStaffAddSchema,
  adminStaffRolesSchema,
  adminLimitsSchema,
  ADMIN_LIMITS,
  SUPPORT_VIEW_MINUTES,
} from "./admin.js";
export type { AdminAbility, AdminLimit, AdminRole, AdminStaffAddInput } from "./admin.js";
