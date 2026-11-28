import { describe, it, expect } from 'vitest';
import { buildCostCenterIssueHtml } from '../CostCenterIssuePanel.js';

describe('buildCostCenterIssueHtml', () => {
  it('escapes names and shows totals', () => {
    const html = buildCostCenterIssueHtml({
      from: '2026-01-01', to: null,
      rows: [{ costCenterId: 'c', costCenterCode: 'C1', costCenterNameAr: '<b>x</b>', itemCode: 'I1', itemNameAr: 'صنف', uom: 'pc', issueCount: 2, totalQty: '15', totalCost: '75' }],
      totals: { totalQty: '15', totalCost: '75' },
    });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('75');
    expect(html).toContain('2026-01-01');
  });
});
