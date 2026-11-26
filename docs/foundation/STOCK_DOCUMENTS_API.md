# Multi-line stock documents: POST /api/inventory/documents

One document, 1 to 500 lines, one transaction (all or nothing). Lines are applied in order, so a later line sees the balance left by earlier ones. Errors name the line: "السطر N: ...".

Header fields: docType (receipt | issue | adjustment | transfer), warehouseId (not transfer), sourceWarehouseId and destWarehouseId (transfer only), reason, memo, entryDate, costSource, adjustmentType, expenseAccountId.
Line fields: itemId, qty, unitCost, costSource, reason, memo, warehouseId, direction, adjustmentType, expenseAccountId. A line value overrides the header value.

| docType | Required (header or line) | Required on every line | Notes |
|---|---|---|---|
| receipt | warehouseId, reason (or memo), costSource | itemId, qty > 0, unitCost > 0 | One JE per line. costSource is an approved cost source name. |
| issue | warehouseId, reason (or memo) | itemId, qty > 0 | Fails on any line that would drive the balance negative. |
| adjustment | warehouseId, reason | itemId, qty > 0, direction (increase or decrease) | adjustmentType defaults to "adjustment". write_off, damage and internal_consumption accept decrease only. Increase also needs costSource and unitCost > 0. |
| transfer | sourceWarehouseId, destWarehouseId | itemId, qty > 0 | Writes an out and an in movement per line. |
