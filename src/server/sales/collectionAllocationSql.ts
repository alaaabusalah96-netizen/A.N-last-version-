/**
 * Posted collection allocations per invoice. Multi-invoice collections store one
 * row per invoice in sales_collection_lines; legacy collections (no lines rows)
 * count against their header invoice. Parameter $1 must be the company id.
 */
export const POSTED_COLLECTION_ALLOCATIONS_SQL = `(
  SELECT l.invoice_id, l.amount, l.collection_id
  FROM sales_collection_lines l
  INNER JOIN sales_collections c ON c.id = l.collection_id AND c.company_id = l.company_id
  WHERE c.company_id = $1 AND c.status = 'posted'
  UNION ALL
  SELECT c.invoice_id, c.amount, c.id AS collection_id
  FROM sales_collections c
  WHERE c.company_id = $1 AND c.status = 'posted'
    AND NOT EXISTS (SELECT 1 FROM sales_collection_lines l WHERE l.company_id = c.company_id AND l.collection_id = c.id)
)`;
