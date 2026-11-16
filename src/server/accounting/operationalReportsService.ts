import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { CashRegisterRepository, defaultCashRegisterRepository } from '../cash/cashRegisterRepository.js';
import { BankAccountRepository, defaultBankAccountRepository } from '../banking/bankAccountRepository.js';
import { ArAgingService, defaultArAgingService } from '../sales/arAgingService.js';
import { ApOpenItemsService, defaultApOpenItemsService } from '../purchasing/apOpenItemsService.js';
import { ValidationError } from '../http/errors.js';
import { toMinorUnits, fromMinorUnits } from '../lib/numeric.js';

export interface CashSummaryRegisterItem {
  id: string;
  code: string;
  nameAr: string;
  isActive: boolean;
  openingBalance: string;
  totalIn: string;
  totalOut: string;
  currentBalance: string;
}

export interface CashSummaryBankItem {
  id: string;
  code: string;
  nameAr: string;
  bankName: string;
  currencyCode: string;
  isActive: boolean;
  openingBalance: string;
  bookBalance: string;
  unmatchedStatementCount: number;
  lastReconciledAt: string | null;
}

export interface OpsCashBankSummary {
  registers: CashSummaryRegisterItem[];
  banks: CashSummaryBankItem[];
  openCustodiesCount: number;
  totalOpenCustodyAmount: string;
  totalCashBalance: string;
  totalBankBalance: string;
  totalLiquidityPosition: string;
}

export interface OpsApSupplierSummary {
  supplierId: string;
  supplierCode: string;
  supplierNameAr: string;
  invoiceCount: number;
  totalOpenAmount: string;
  bucket0To30: string;
  bucket31To60: string;
  bucket61Plus: string;
}

export interface OpsArApAgingSummary {
  ar: {
    openInvoiceCount: number;
    customerCount: number;
    totalOpen: string;
    bucket0To30: string;
    bucket31To60: string;
    bucket61Plus: string;
    customers: Array<{
      customerId: string;
      customerCode: string;
      customerNameAr: string;
      invoiceCount: number;
      totalOpenAmount: string;
      bucket0To30: string;
      bucket31To60: string;
      bucket61Plus: string;
    }>;
  };
  ap: {
    openInvoiceCount: number;
    supplierCount: number;
    totalOpen: string;
    bucket0To30: string;
    bucket31To60: string;
    bucket61Plus: string;
    suppliers: OpsApSupplierSummary[];
  };
  netReceivablesMinusPayables: string;
}

export class OperationalReportsService {
  constructor(
    private cashRegisterRepo: CashRegisterRepository = defaultCashRegisterRepository,
    private bankAccountRepo: BankAccountRepository = defaultBankAccountRepository,
    private arAgingService: ArAgingService = defaultArAgingService,
    private apOpenItemsService: ApOpenItemsService = defaultApOpenItemsService
  ) {}

  async getCashAndBankSummary(
    companyId: string,
    customExecutor?: DbExecutor
  ): Promise<OpsCashBankSummary> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    const run = async (tx: DbExecutor) => {
      const [rawRegisters, rawBanks, custodyRes] = await Promise.all([
        this.cashRegisterRepo.listByCompany(companyId, tx),
        this.bankAccountRepo.listByCompany(companyId, tx),
        tx.query<{ cnt: string | number; total: string | number }>(
          `SELECT COUNT(*)::int as cnt, COALESCE(SUM(amount), 0)::text as total
           FROM custody_records
           WHERE company_id = $1 AND status = 'disbursed'`,
          [companyId]
        ),
      ]);

      const registers: CashSummaryRegisterItem[] = [];
      let totalCashUnits = BigInt(0);

      for (const reg of rawRegisters) {
        const sums = await this.cashRegisterRepo.sumMovements(companyId, reg.id, tx);
        const openUnits = toMinorUnits(reg.openingBalance, 2);
        const inUnits = toMinorUnits(sums.totalIn, 2);
        const outUnits = toMinorUnits(sums.totalOut, 2);
        const currentUnits = openUnits + inUnits - outUnits;
        totalCashUnits += currentUnits;
        registers.push({
          id: reg.id,
          code: reg.code,
          nameAr: reg.nameAr,
          isActive: reg.isActive,
          openingBalance: fromMinorUnits(openUnits, 2),
          totalIn: fromMinorUnits(inUnits, 2),
          totalOut: fromMinorUnits(outUnits, 2),
          currentBalance: fromMinorUnits(currentUnits, 2),
        });
      }

      const banks: CashSummaryBankItem[] = [];
      let totalBankUnits = BigInt(0);
      for (const b of rawBanks) {
        const bookUnits = toMinorUnits(b.bookBalance ?? b.openingBalance, 2);
        totalBankUnits += bookUnits;
        banks.push({
          id: b.id,
          code: b.code,
          nameAr: b.nameAr,
          bankName: b.bankName,
          currencyCode: b.currencyCode,
          isActive: b.isActive,
          openingBalance: fromMinorUnits(toMinorUnits(b.openingBalance, 2), 2),
          bookBalance: fromMinorUnits(bookUnits, 2),
          unmatchedStatementCount: b.unmatchedStatementCount ?? 0,
          lastReconciledAt: b.lastReconciledAt ?? null,
        });
      }

      const openCustodiesCount = Number(custodyRes.rows[0]?.cnt ?? 0);
      const openCustodyUnits = toMinorUnits(custodyRes.rows[0]?.total ?? '0', 2);

      return {
        registers,
        banks,
        openCustodiesCount,
        totalOpenCustodyAmount: fromMinorUnits(openCustodyUnits, 2),
        totalCashBalance: fromMinorUnits(totalCashUnits, 2),
        totalBankBalance: fromMinorUnits(totalBankUnits, 2),
        totalLiquidityPosition: fromMinorUnits(totalCashUnits + totalBankUnits, 2),
      };
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async getArApAgingSummary(
    companyId: string,
    customExecutor?: DbExecutor
  ): Promise<OpsArApAgingSummary> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    const run = async (tx: DbExecutor) => {
      const [arReport, apItems] = await Promise.all([
        this.arAgingService.getAgingReport(companyId, tx),
        this.apOpenItemsService.listOpenItems(companyId, undefined, tx),
      ]);

      const arTotalUnits = toMinorUnits(arReport.grandTotalOpen, 2);
      const ar030 = toMinorUnits(arReport.grandTotal0To30, 2);
      const ar3160 = toMinorUnits(arReport.grandTotal31To60, 2);
      const ar61Plus = toMinorUnits(arReport.grandTotal61Plus, 2);

      const apOpenOnly = apItems.filter((item) => toMinorUnits(item.remainingOpenAmount, 2) > BigInt(0));
      let apTotalUnits = BigInt(0);
      let ap030 = BigInt(0);
      let ap3160 = BigInt(0);
      let ap61Plus = BigInt(0);

      const supplierAcc = new Map<
        string,
        {
          supplierId: string;
          supplierCode: string;
          supplierNameAr: string;
          invoiceCount: number;
          total: bigint;
          b030: bigint;
          b3160: bigint;
          b61: bigint;
        }
      >();

      for (const item of apOpenOnly) {
        const remUnits = toMinorUnits(item.remainingOpenAmount, 2);
        apTotalUnits += remUnits;

        let entry = supplierAcc.get(item.supplierId);
        if (!entry) {
          entry = {
            supplierId: item.supplierId,
            supplierCode: item.supplierCode,
            supplierNameAr: item.supplierNameAr,
            invoiceCount: 0,
            total: BigInt(0),
            b030: BigInt(0),
            b3160: BigInt(0),
            b61: BigInt(0),
          };
          supplierAcc.set(item.supplierId, entry);
        }

        entry.invoiceCount++;
        entry.total += remUnits;

        if (item.agingDays > 60) {
          ap61Plus += remUnits;
          entry.b61 += remUnits;
        } else if (item.agingDays > 30) {
          ap3160 += remUnits;
          entry.b3160 += remUnits;
        } else {
          ap030 += remUnits;
          entry.b030 += remUnits;
        }
      }

      const suppliers: OpsApSupplierSummary[] = Array.from(supplierAcc.values()).map((s) => ({
        supplierId: s.supplierId,
        supplierCode: s.supplierCode,
        supplierNameAr: s.supplierNameAr,
        invoiceCount: s.invoiceCount,
        totalOpenAmount: fromMinorUnits(s.total, 2),
        bucket0To30: fromMinorUnits(s.b030, 2),
        bucket31To60: fromMinorUnits(s.b3160, 2),
        bucket61Plus: fromMinorUnits(s.b61, 2),
      }));

      return {
        ar: {
          openInvoiceCount: arReport.items.length,
          customerCount: arReport.customerSummaries.length,
          totalOpen: fromMinorUnits(arTotalUnits, 2),
          bucket0To30: fromMinorUnits(ar030, 2),
          bucket31To60: fromMinorUnits(ar3160, 2),
          bucket61Plus: fromMinorUnits(ar61Plus, 2),
          customers: arReport.customerSummaries.map((c) => ({
            customerId: c.customerId,
            customerCode: c.customerCode,
            customerNameAr: c.customerNameAr,
            invoiceCount: c.invoiceCount,
            totalOpenAmount: fromMinorUnits(toMinorUnits(c.totalOpenAmount, 2), 2),
            bucket0To30: fromMinorUnits(toMinorUnits(c.bucket0To30, 2), 2),
            bucket31To60: fromMinorUnits(toMinorUnits(c.bucket31To60, 2), 2),
            bucket61Plus: fromMinorUnits(toMinorUnits(c.bucket61Plus, 2), 2),
          })),
        },
        ap: {
          openInvoiceCount: apOpenOnly.length,
          supplierCount: suppliers.length,
          totalOpen: fromMinorUnits(apTotalUnits, 2),
          bucket0To30: fromMinorUnits(ap030, 2),
          bucket31To60: fromMinorUnits(ap3160, 2),
          bucket61Plus: fromMinorUnits(ap61Plus, 2),
          suppliers,
        },
        netReceivablesMinusPayables: fromMinorUnits(arTotalUnits - apTotalUnits, 2),
      };
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultOperationalReportsService = new OperationalReportsService();
