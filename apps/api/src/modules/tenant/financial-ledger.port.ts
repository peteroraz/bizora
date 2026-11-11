import { Injectable } from "@nestjs/common";

/**
 * Port for financial modules. Sprint 2.5 has no ledgers; sales/payments will implement this
 * and block base-currency changes once posted transactions exist. See docs/adr/ADR-003-currency-locking.md.
 */
export interface FinancialLedgerPort {
  hasPostedTransactions(tenantId: string, businessId: string): Promise<boolean>;
}

@Injectable()
export class EmptyFinancialLedger implements FinancialLedgerPort {
  async hasPostedTransactions(_tenantId: string, _businessId: string): Promise<boolean> {
    return false;
  }
}
