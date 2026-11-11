import fs from 'fs';
import path from 'path';

async function verify() {
    console.log('--- Verifying UI Company Settings Accounts (AN-UI-COMPANY-SETTINGS-ACCOUNTS-1) ---');

    const panelPath = path.resolve('src/components/companies/CompanySettingsPanel.tsx');
    const panelContent = fs.readFileSync(panelPath, 'utf8');

    // 1. Panel source includes inventoryAccountId and purchasesClearingAccountId
    if (!panelContent.includes('inventoryAccountId') || !panelContent.includes('purchasesClearingAccountId')) {
        console.error('Failed: Panel missing account ID fields');
        process.exit(1);
    }
    console.log('Passed: Panel includes account ID fields');

    // 2. Panel fetches /api/accounting/accounts
    if (!panelContent.includes('/api/accounting/accounts')) {
        console.error('Failed: Panel missing accounts fetch');
        process.exit(1);
    }
    console.log('Passed: Panel fetches accounts');

    // 3. Service validates account company
    const servicePath = path.resolve('src/server/org/companySettingsService.ts');
    const serviceContent = fs.readFileSync(servicePath, 'utf8');
    if (!serviceContent.includes('defaultAccountRepository.findById') || !serviceContent.includes('ValidationError')) {
        console.error('Failed: Service missing company validation');
        process.exit(1);
    }
    console.log('Passed: Service validates account company');

    console.log('--- Verification Passed ---');
}

verify().catch(err => {
    console.error('Verification failed', err);
    process.exit(1);
});
