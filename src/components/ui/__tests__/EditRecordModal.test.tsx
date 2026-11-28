import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { EditRecordModal } from '../EditRecordModal.js';

describe('EditRecordModal', () => {
  it('renders the fields with initial values and a checkbox', () => {
    const html = renderToStaticMarkup(
      <EditRecordModal
        title="تعديل"
        initial={{ nameAr: 'مستودع أ', isActive: true }}
        fields={[
          { key: 'nameAr', label: 'الاسم', required: true },
          { key: 'isActive', label: 'نشط', type: 'checkbox' },
        ]}
        onSave={async () => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain('مستودع أ');
    expect(html).toContain('name="edit-isActive"');
    expect(html).toContain('checked');
    expect(html).toContain('حفظ التعديل');
  });
});
