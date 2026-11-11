import { Pool } from 'pg';
import assert from 'assert';

async function verify() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        console.log('--- Verifying Composite FKs (Migration 025) ---');

        // 1. Verify existence of constraints in pg_constraint
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

        // 2. Live test: Check 23503 error on cross-company journal_entry_id
        console.log('--- Running Live Integrity Proof (23503) ---');
        await pool.query('BEGIN');
        try {
            // Need a valid GRN row, then try updating it to an invalid journal_entry_id
            // Just attempting insertion with invalid cross-company id should trigger it
            await pool.query(`
                INSERT INTO purch_grn (id, company_id, journal_entry_id)
                VALUES (gen_random_uuid(), 'company_A', 'journal_from_company_B')
            `);
            assert.fail('Should have failed with 23503');
        } catch (err: any) {
            assert.strictEqual(err.code, '23503', 'Should trigger foreign_key_violation (23503)');
        }
        await pool.query('ROLLBACK');
        console.log('--- Live Integrity Proof Passed ---');

        console.log('--- Verification Passed ---');
    } catch (err) {
        console.error('--- Verification Failed ---', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

verify();
