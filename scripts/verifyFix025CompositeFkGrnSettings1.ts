import { Pool } from 'pg';
import assert from 'assert';
import { randomUUID } from 'crypto';

async function verify() {
    // Prefer MIGRATION_DATABASE_URL for superuser access for fixtures
    const connStr = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
    if (!connStr) {
        console.log('Skipping live proof: DATABASE_URL not configured');
        process.exit(0);
    }
    const pool = new Pool({ connectionString: connStr });
    
    try {
        console.log('--- Verifying Composite FKs (Migration 025) ---');

        const { rows } = await pool.query(`
            SELECT conname
            FROM pg_constraint
            WHERE conname IN (
                'purch_grn_journal_entry_id_company_id_fkey',
                'company_settings_inventory_account_id_company_id_fkey',
                'company_settings_purchases_clearing_account_id_company_id_fkey'
            );
        `);
        assert.strictEqual(rows.length, 3, 'All composite FKs should exist');
        console.log('Passed: Constraints exist');

        console.log('--- Running Live Integrity Proof (23503) ---');
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');

            // Setup fixtures for Company A
            const compA = randomUUID();
            await client.query('INSERT INTO companies (id, code, name_ar) VALUES ($1, $2, $3)', [compA, 'CA', 'Comp A']);
            
            const supplierA = randomUUID();
            await client.query('INSERT INTO purch_suppliers (id, company_id, code, name_ar) VALUES ($1, $2, $3, $4)', [supplierA, compA, 'SUP1', 'Supplier A']);
            
            const warehouseA = randomUUID();
            await client.query('INSERT INTO inv_warehouses (id, company_id, code, name_ar) VALUES ($1, $2, $3, $4)', [warehouseA, compA, 'WHA', 'Warehouse A']);

            // Setup fixtures for Company B
            const compB = randomUUID();
            await client.query('INSERT INTO companies (id, code, name_ar) VALUES ($1, $2, $3)', [compB, 'CB', 'Comp B']);
            
            const journalB = randomUUID();
            await client.query('INSERT INTO journal_entries (id, company_id) VALUES ($1, $2)', [journalB, compB]);
            
            // 23503 Proof T1: GRN for Company A pointing at Journal of Company B
            const sp1 = 'savepoint_t1';
            await client.query(`SAVEPOINT ${sp1}`);
            try {
                await client.query(`
                    INSERT INTO purch_grn (id, company_id, supplier_id, warehouse_id, journal_entry_id, status)
                    VALUES ($1, $2, $3, $4, $5, 'draft')
                `, [randomUUID(), compA, supplierA, warehouseA, journalB]);
                assert.fail('Should have failed with 23503 (composite journal FK)');
            } catch (err: any) {
                if (err.code !== '23503') {
                    console.error(`Unexpected error code ${err.code}: ${err.message}`);
                    throw err;
                }
                // Verify it targets the intended constraint
                if (err.constraint && !err.constraint.includes('journal_entry_id_company_id')) {
                    throw new Error(`Caught 23503 but target was ${err.constraint}, not composite journal FK`);
                }
                console.log('Passed: Caught expected 23503 for composite GRN -> Journal FK');
            }
            await client.query(`ROLLBACK TO SAVEPOINT ${sp1}`);

            // 23503 Proof T2: Company A settings pointing at Account of Company B
            const accountB = randomUUID();
            await client.query('INSERT INTO accounts (id, company_id, code, name_ar, account_type) VALUES ($1, $2, $3, $4, $5)', [accountB, compB, 'ACCB', 'Account B', 'asset']);
            
            const sp2 = 'savepoint_t2';
            await client.query(`SAVEPOINT ${sp2}`);
            try {
                await client.query(`
                    INSERT INTO company_settings (company_id, inventory_account_id)
                    VALUES ($1, $2)
                    ON CONFLICT (company_id) DO UPDATE SET inventory_account_id = EXCLUDED.inventory_account_id
                `, [compA, accountB]);
                assert.fail('Should have failed with 23503 (composite settings account FK)');
            } catch (err: any) {
                if (err.code !== '23503') throw err;
                if (err.constraint && !err.constraint.includes('inventory_account_id_company_id')) {
                    throw new Error(`Caught 23503 but target was ${err.constraint}, not composite settings account FK`);
                }
                console.log('Passed: Caught expected 23503 for composite Company Settings -> Accounts FK');
            }
            await client.query(`ROLLBACK TO SAVEPOINT ${sp2}`);

            await client.query('ROLLBACK');
        } finally {
            client.release();
        }

        console.log('--- Verification Passed ---');
    } catch (err) {
        console.error('--- Verification Failed ---', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

verify();
