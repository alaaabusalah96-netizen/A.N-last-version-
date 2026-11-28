import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { InventoryWorkspace, matchesItemSearch } from '../InventoryWorkspace.js';

const html = (userRole: string, permissions: string[]) =>
  renderToStaticMarkup(<InventoryWorkspace userRole={userRole} permissions={permissions} />);

describe('InventoryWorkspace action gates follow the API permissions', () => {
  it('read-only role sees no action buttons', () => {
    const h = html('company_user', ['inventory:read']);
    for (const t of ['إذن استلام', 'إذن صرف', 'تسوية / إتلاف', 'إذن تحويل', 'مستند متعدد الأسطر']) {
      expect(h).not.toContain(t);
    }
  });
  it('movement-only role (warehouse keeper) sees receive/issue/transfer/document but not adjustment', () => {
    const h = html('company_user', ['inventory:read', 'inventory:movement']);
    expect(h).toContain('إذن استلام');
    expect(h).toContain('إذن صرف');
    expect(h).toContain('إذن تحويل');
    expect(h).toContain('مستند متعدد الأسطر');
    expect(h).not.toContain('تسوية / إتلاف');
  });
  it('write-only role (no movement) no longer sees movement buttons', () => {
    const h = html('company_user', ['inventory:read', 'inventory:write']);
    expect(h).not.toContain('إذن استلام');
    expect(h).not.toContain('إذن صرف');
    expect(h).not.toContain('تسوية / إتلاف');
  });
  it('adjust-only role sees only the adjustment button and the document button', () => {
    const h = html('company_user', ['inventory:read', 'inventory:valuation:adjust']);
    expect(h).toContain('تسوية / إتلاف');
    expect(h).not.toContain('إذن استلام');
    expect(h).not.toContain('إذن صرف');
    expect(h).not.toContain('إذن تحويل');
  });
  it('admin sees everything', () => {
    const h = html('company_admin', []);
    for (const t of ['إذن استلام', 'إذن صرف', 'تسوية / إتلاف', 'إذن تحويل', 'مستند متعدد الأسطر']) {
      expect(h).toContain(t);
    }
  });
});

describe('item search', () => {
  it('matches by code or Arabic name, case-insensitive, empty matches all', () => {
    expect(matchesItemSearch('', 'ITEM-1', 'قلم')).toBe(true);
    expect(matchesItemSearch('item-1', 'ITEM-1', 'قلم')).toBe(true);
    expect(matchesItemSearch('قل', 'ITEM-1', 'قلم')).toBe(true);
    expect(matchesItemSearch('  ورق ', 'ITEM-1', 'قلم')).toBe(false);
    expect(matchesItemSearch('x', undefined, undefined)).toBe(false);
  });
  it('renders the search box on the balances tab', () => {
    expect(html('company_user', ['inventory:read'])).toContain('data-testid="inventory-search"');
  });
});

