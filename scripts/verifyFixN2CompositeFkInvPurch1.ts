import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { buildPgConfig } from '../src/server/db/connection.js';

export function isProductionOrSupabaseDb(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return (
      host.includes('supabase.co') ||
      host.includes('pooler.supabase') ||
      host.includes('supabase.com') ||
      host.includes('aws.neon.tech') ||
      host.includes('rds.amazonaws.com')
    );
  } catch {
    const lower = urlStr.toLowerCase();
    return (
      lower.includes('supabase.co') ||
      lower.includes('pooler.supabase') ||
      lower.includes('supabase.com') ||
      lower.includes('aws.neon.tech') ||
      lower.includes('rds.amazonaws.com')
    );
  }
}

async function runVerification() {
  console.log('=== RUNNING INVENTORY & PURCHASING COMPOSITE FOREIGN KEY VERIFICATION (AN-FIX-N2-COMPOSITE-FK-INV-PURCH-1) ===');
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  function reportSkipped(message: string) {
    console.log(`[SKIPPED] ${message}`);
    skipped++;
  }

  const root = process.cwd();

  // S1: Migration 023 file exists
  const migrationPath = path.join(root, 'database/migrations/023_inv_purch_composite_fk.sql');
  const migrationExists = fs.existsSync(migrationPath);
  assert(migrationExists, 'S1: 023_inv_purch_composite_fk.sql migration file exists');

  let migrationContent = '';
  if (migrationExists) {
    migrationContent = fs.readFileSync(migrationPath, 'utf8');
  }

  // S2: File contains UNIQUE (company_id, id) for inventory and purchasing parent tables
  const hasUniqueWh = migrationContent.includes('uq_inv_warehouses_company_id_id') && migrationContent.includes('UNIQUE (company_id, id)');
  const hasUniqueItems = migrationContent.includes('uq_inv_items_company_id_id') && migrationContent.includes('UNIQUE (company_id, id)');
  const hasUniqueSuppliers = migrationContent.includes('uq_purch_suppliers_company_id_id') && migrationContent.includes('UNIQUE (company_id, id)');
  const hasUniqueGrn = migrationContent.includes('uq_purch_grn_company_id_id') && migrationContent.includes('UNIQUE (company_id, id)');
  assert(hasUniqueWh && hasUniqueItems && hasUniqueSuppliers && hasUniqueGrn, 'S2: Migration 023 defines composite UNIQUE (company_id, id) for warehouses, items, suppliers, and grns');

  // S3: File contains composite FOREIGN KEYs for inventory and purchasing child tables
  const hasInvBalanceFks = migrationContent.includes('fk_inv_stock_balances_warehouse_company') && migrationContent.includes('fk_inv_stock_balances_item_company');
  const hasInvMovementFks = migrationContent.includes('fk_inv_stock_movements_warehouse_company') && migrationContent.includes('fk_inv_stock_movements_item_company');
  const hasPurchGrnFks = migrationContent.includes('fk_purch_grn_supplier_company') && migrationContent.includes('fk_purch_grn_warehouse_company');
  const hasPurchGrnLinesFks = migrationContent.includes('fk_purch_grn_lines_grn_company') && migrationContent.includes('fk_purch_grn_lines_item_company');
  assert(hasInvBalanceFks && hasInvMovementFks && hasPurchGrnFks && hasPurchGrnLinesFks, 'S3: Migration 023 defines composite FOREIGN KEYs on inv_stock_balances, inv_stock_movements, purch_grn, and purch_grn_lines');

  // S4: Pre-migration orphan check / RAISE present
  const hasOrphanCheck = migrationContent.includes('RAISE EXCEPTION') && migrationContent.includes('orphan_count');
  assert(hasOrphanCheck, 'S4: Migration 023 includes pre-migration orphan & cross-company mismatch check with RAISE EXCEPTION');

  // S5: AI_PROJECT_STATE.md records package
  const statePath = path.join(root, 'docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const hasStateRecord = stateContent.includes('AN-FIX-N2-COMPOSITE-FK-INV-PURCH-1');
  assert(hasStateRecord, 'S5: AI_PROJECT_STATE.md records AN-FIX-N2-COMPOSITE-FK-INV-PURCH-1');

  // Live Database Proof (T1–T4) if disposable DB provided and N2_ALLOW_DISPOSABLE=1
  const dbUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    reportSkipped('Live FK rejection proof skipped: No DATABASE_URL or MIGRATION_DATABASE_URL configured');
  } else if (isProductionOrSupabaseDb(dbUrl) && process.env.N2_ALLOW_DISPOSABLE !== '1') {
    reportSkipped('Live FK rejection proof skipped: Protected database URL detected and N2_ALLOW_DISPOSABLE is not set to 1');
  } else {
    console.log('[Live Proof] Connecting to test database to verify inventory & purchasing composite FK cross-tenant rejection...');
    const pgConfig = buildPgConfig(dbUrl, process.env);
    const client = new pg.Client(pgConfig);
    try {
      await client.connect();
      await client.query('BEGIN;');

      // Create two temporary test companies
      const comp1Res = await client.query("INSERT INTO companies (code, name_ar) VALUES ('N2-INV-A', 'شركة مخزون أ') RETURNING id;");
      const comp1Id = comp1Res.rows[0].id;

      const comp2Res = await client.query("INSERT INTO companies (code, name_ar) VALUES ('N2-INV-B', 'شركة مخزون ب') RETURNING id;");
      const comp2Id = comp2Res.rows[0].id;

      // Create warehouse and item in Company 1
      const wh1Res = await client.query(
        "INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1, 'WH-A', 'مستودع أ') RETURNING id;",
        [comp1Id]
      );
      const wh1Id = wh1Res.rows[0].id;

      const item1Res = await client.query(
        "INSERT INTO inv_items (company_id, code, name_ar, unit) VALUES ($1, 'ITEM-A', 'صنف أ', 'pcs') RETURNING id;",
        [comp1Id]
      );
      const item1Id = item1Res.rows[0].id;

      // Create supplier in Company 1
      const supp1Res = await client.query(
        "INSERT INTO purch_suppliers (company_id, code, name_ar) VALUES ($1, 'SUPP-A', 'مورد أ') RETURNING id;",
        [comp1Id]
      );
      const supp1Id = supp1Res.rows[0].id;

      // Create GRN in Company 1
      const grn1Res = await client.query(
        "INSERT INTO purch_grn (company_id, grn_no, supplier_id, warehouse_id, status) VALUES ($1, 'GRN-001', $2, $3, 'draft') RETURNING id;",
        [comp1Id, supp1Id, wh1Id]
      );
      const grn1Id = grn1Res.rows[0].id;

      // T1: Try inserting inv_stock_balances in Company 2 pointing to warehouse in Company 1 -> must fail FK violation
      let t1Failed = false;
      try {
        await client.query(
          "INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, quantity) VALUES ($1, $2, $3, 10);",
          [comp2Id, wh1Id, item1Id]
        );
      } catch (err: any) {
        if (err.code === '23503' || err.message.includes('foreign key')) {
          t1Failed = true;
        } else {
          throw err;
        }
      }
      assert(t1Failed, 'T1: Inserting inv_stock_balance with cross-company warehouse_id correctly rejected by composite FK');

      // T2: Try inserting inv_stock_movements in Company 2 pointing to item in Company 1 -> must fail FK violation
      let t2Failed = false;
      try {
        await client.query(
          "INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, quantity) VALUES ($1, $2, $3, 'receive', 10);",
          [comp2Id, wh1Id, item1Id]
        );
      } catch (err: any) {
        if (err.code === '23503' || err.message.includes('foreign key')) {
          t2Failed = true;
        } else {
          throw err;
        }
      }
      assert(t2Failed, 'T2: Inserting inv_stock_movement with cross-company item_id correctly rejected by composite FK');

      // T3: Try inserting purch_grn in Company 2 pointing to supplier in Company 1 -> must fail FK violation
      let t3Failed = false;
      try {
        await client.query(
          "INSERT INTO purch_grn (company_id, grn_no, supplier_id, warehouse_id, status) VALUES ($1, 'GRN-002', $2, $3, 'draft');",
          [comp2Id, supp1Id, wh1Id]
        );
      } catch (err: any) {
        if (err.code === '23503' || err.message.includes('foreign key')) {
          t3Failed = true;
        } else {
          throw err;
        }
      }
      assert(t3Failed, 'T3: Inserting purch_grn with cross-company supplier_id correctly rejected by composite FK');

      // T4: Try inserting purch_grn_lines in Company 2 pointing to GRN in Company 1 -> must fail FK violation
      let t4Failed = false;
      try {
        await client.query(
          "INSERT INTO purch_grn_lines (company_id, grn_id, item_id, received_quantity, unit_cost) VALUES ($1, $2, $3, 5, 10);",
          [comp2Id, grn1Id, item1Id]
        );
      } catch (err: any) {
        if (err.code === '23503' || err.message.includes('foreign key')) {
          t4Failed = true;
        } else {
          throw err;
        }
      }
      assert(t4Failed, 'T4: Inserting purch_grn_lines with cross-company grn_id correctly rejected by composite FK');

      await client.query('ROLLBACK;');
      await client.end();
    } catch (err) {
      try {
        await client.end();
      } catch {}
      console.error('[Live Proof Error]:', err);
      assert(false, `Live FK rejection proof encountered unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped} | Blocked: 0`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
