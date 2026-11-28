/**
 * Posted supplier payment allocations per supplier invoice. Multi-invoice payments store
 * one row per invoice in purch_supplier_payment_lines; legacy payments (no lines rows)
 * count against their header invoice. Parameter $1 must be the company id.
 */
export const POSTED_PAYMENT_ALLOCATIONS_SQL = `(
  SELECT l.invoice_id, l.amount, l.payment_id
  FROM purch_supplier_payment_lines l
  INNER JOIN purch_supplier_payments p ON p.id = l.payment_id AND p.company_id = l.company_id
  WHERE p.company_id = $1 AND p.status = 'posted'
  UNION ALL
  SELECT p.invoice_id, p.amount, p.id AS payment_id
  FROM purch_supplier_payments p
  WHERE p.company_id = $1 AND p.status = 'posted'
    AND NOT EXISTS (SELECT 1 FROM purch_supplier_payment_lines l WHERE l.company_id = p.company_id AND l.payment_id = p.id)
)`;
