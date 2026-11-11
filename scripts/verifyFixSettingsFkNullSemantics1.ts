import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import assert from 'assert';
import { randomUUID } from 'crypto';

async function verify() {
    console.log('--- Verifying Settings FK Null Semantics (AN-FIX-SETTINGS-FK-NULL-SEMANTICS-1) ---');

    // 1. Static Checks
    console.log('--- Running Static Checks ---');
    const migrationPath = path.resolve('database/migrations/026_settings_account_fk_on_delete.sql');
    const migrationContent = fs.readFileSync(migrationPath, 'utf8');
    assert(migrationContent.includes('ON DELETE SET NULL (inventory_account_id)'), 'Migration 026 should specify column for SET NULL');
    assert(migrationContent.includes('ON DELETE SET NULL (purchases_clearing_account_id)'), 'Migration 026 should specify columns for SET NULL');
    console.log('Passed: Migration 026 static check');

    const repoPath = path.resolve('src/server/org/companySettingsRepository.ts');
    const repoContent = fs.readFileSync(repoPath, 'utf8');
    assert(!repoContent.includes('inventory_account_id = COALESCE(EXCLUDED.inventory_account_id'), 'Repository should not block null clear with COALESCE');
    assert(repoContent.includes('CASE WHEN $11 THEN EXCLUDED.inventory_account_id'), 'Repository should use CASE for conditional update');
    console.log('Passed: Repository static check');

    const servicePath = path.resolve('src/server/org/companySettingsService.ts');
    const serviceContent = fs.readFileSync(servicePath, 'utf8');
    assert(serviceContent.includes("typeof input.inventoryAccountId === 'string'"), 'Service should only validate if string provided');
    assert(serviceContent.includes('defaultAuditService.record'), 'Service should record audit');
    assert(serviceContent.includes('executor: tx'), 'Service should pass executor to audit');
    console.log('Passed: Service static check');

    // 2. Live Proof (optional/if DB available)
    const connStr = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
    if (connStr) {
        console.log('--- Running Live Proof ---');
        const pool = new Pool({ connectionString: connStr });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const compId = randomUUID();
            await client.query('INSERT INTO companies (id, code, name_ar) VALUES ($1, $2, $3)', [compId, 'SEM1', 'Null Semantics Comp']);
            
            const accId = randomUUID();
            await client.query('INSERT INTO accounts (id, company_id, code, name_ar, account_type) VALUES ($1, $2, $3, $4, $5)', [accId, compId, 'ACC1', 'Acc 1', 'asset']);
            
            await client.query(`
                INSERT INTO company_settings (company_id, inventory_account_id)
                VALUES ($1, $2)
            `, [compId, accId]);
            
            // Delete account
            await client.query('DELETE FROM accounts WHERE id = $1', [accId]);
            
            const { rows } = await client.query('SELECT inventory_account_id FROM company_settings WHERE company_id = $1', [compId]);
            assert.strictEqual(rows[0].inventory_account_id, null, 'inventory_account_id should be NULL after account deletion');
            
            await client.query('ROLLBACK');
            console.log('Passed: Live proof of SET NULL semantics');
        } finally {
            client.release();
            await pool.end();
        }
    } else {
        console.log('Skipping live proof: DATABASE_URL not configured');
    }

    console.log('--- Verification Passed ---');
}

verify().catch(err => {
    console.error('Verification failed', err);
    process.exit(1);
});
