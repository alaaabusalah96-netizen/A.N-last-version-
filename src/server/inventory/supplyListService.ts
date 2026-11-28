import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';

export interface SupplyListFilter {
  from?: string;
  to?: string;
  itemId?: string;
  warehouseId?: string;
  /** Only receipts that carry an expiry date on or before this date. */
  expiringBy?: string;
}

export interface SupplyListRow {
  movementId: string;
  receivedDate: string;
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  uom: string;
  warehouseId: string;
  warehouseNameAr: string;
  qty: string;
  expiryDate: string | null;
  /** Arabic label: the date, or "بدون تاريخ صلاحية" when none was entered. */
  expiryLabel: string;
  status: 'expired' | 'valid' | 'none';
}

export interface SupplyListReport {
  from: string | null;
  to: string | null;
  asOf: string;
  rows: SupplyListRow[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const NO_EXPIRY_LABEL = 'بدون تاريخ صلاحية';

export class SupplyListService {
  /** Receipts by date with their expiry date (dates only, no lot or FEFO tracking). */
  async report(companyId: string, f: SupplyListFilter): Promise<SupplyListReport> {
    if (!companyId || typeof companyId !== 'string') throw new ValidationError('companyId is required');
    for (const [v, m] of [[f.from, 'تاريخ البداية غير صالح'], [f.to, 'تاريخ النهاية غير صالح'], [f.expiringBy, 'تاريخ الصلاحية غير صالح']] as const) {
      if (v && !DATE_RE.test(v)) throw new ValidationError(m);
    }
    if (f.from && f.to && f.from > f.to) throw new ValidationError('تاريخ البداية بعد تاريخ النهاية');
    if (f.itemId && !isUuid(f.itemId)) throw new ValidationError('الصنف غير صالح');
    if (f.warehouseId && !isUuid(f.warehouseId)) throw new ValidationError('المستودع غير صالح');

    return await withTenantTransaction(companyId, async (tx) => {
      const res = await tx.query<any>(
        `SELECT m.id as "movementId", to_char(m.created_at, 'YYYY-MM-DD') as "receivedDate",
                m.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr", i.uom,
                m.warehouse_id as "warehouseId", w.name_ar as "warehouseNameAr",
                m.qty::text as qty, to_char(m.expiry_date, 'YYYY-MM-DD') as "expiryDate",
                to_char(CURRENT_DATE, 'YYYY-MM-DD') as "asOf"
         FROM inv_stock_movements m
         INNER JOIN inv_items i ON i.company_id = m.company_id AND i.id = m.item_id
         INNER JOIN inv_warehouses w ON w.company_id = m.company_id AND w.id = m.warehouse_id
         WHERE m.company_id = $1 AND m.movement_type = 'receive'
           AND ($2::date IS NULL OR m.created_at >= $2::date)
           AND ($3::date IS NULL OR m.created_at < ($3::date + 1))
           AND ($4::uuid IS NULL OR m.item_id = $4::uuid)
           AND ($5::uuid IS NULL OR m.warehouse_id = $5::uuid)
           AND ($6::date IS NULL OR m.expiry_date <= $6::date)
         ORDER BY m.created_at DESC, i.code
         LIMIT 2000`,
        [companyId, f.from || null, f.to || null, f.itemId || null, f.warehouseId || null, f.expiringBy || null]
      );
      const asOf = res.rows[0]?.asOf ?? new Date().toISOString().slice(0, 10);
      const rows: SupplyListRow[] = res.rows.map((r: any) => ({
        movementId: r.movementId, receivedDate: r.receivedDate, itemId: r.itemId, itemCode: r.itemCode,
        itemNameAr: r.itemNameAr, uom: r.uom, warehouseId: r.warehouseId, warehouseNameAr: r.warehouseNameAr,
        qty: r.qty, expiryDate: r.expiryDate,
        expiryLabel: r.expiryDate ? r.expiryDate : NO_EXPIRY_LABEL,
        status: !r.expiryDate ? 'none' : r.expiryDate < asOf ? 'expired' : 'valid',
      }));
      return { from: f.from || null, to: f.to || null, asOf, rows };
    });
  }
}

export const defaultSupplyListService = new SupplyListService();
