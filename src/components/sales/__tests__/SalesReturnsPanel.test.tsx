import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { SalesReturnsPanel } from '../SalesReturnsPanel.js';

describe('SalesReturnsPanel', () => {
  it('shows the new-return button only for writers', () => {
    const base = { companyId: 'c', canPost: false, invoices: [], warehouses: [] };
    const w = renderToStaticMarkup(<SalesReturnsPanel {...base} canWrite={true} />);
    const r = renderToStaticMarkup(<SalesReturnsPanel {...base} canWrite={false} />);
    expect(w).toContain('مرتجع مبيعات جديد');
    expect(r).not.toContain('مرتجع مبيعات جديد');
    expect(w).toContain('data-testid="sales-returns-panel"');
  });
});
