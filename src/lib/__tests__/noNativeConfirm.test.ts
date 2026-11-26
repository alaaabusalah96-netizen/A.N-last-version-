import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Native confirm()/alert()/prompt() are silently blocked inside sandboxed iframes (AI Studio),
// which froze the purchasing "post" buttons. UI code must use the in-app useConfirm hook.
function walk(dir: string, out: string[] = []): string[] {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== '__tests__') walk(p, out); }
    else if (/\.tsx$/.test(f.name)) out.push(p);
  }
  return out;
}

describe('UI uses in-app dialogs', () => {
  it('no native confirm/alert/prompt in components', () => {
    const offenders = walk(path.join(process.cwd(), 'src/components')).filter((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return /(^|[^.\w])(window\.)?(confirm|alert|prompt)\(/m.test(src);
    });
    expect(offenders).toEqual([]);
  });
  it('purchasing workspace renders the confirm dialog', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/components/purchasing/PurchasingWorkspace.tsx'), 'utf8');
    expect(src).toContain('useConfirm()');
    expect(src).toContain('{confirmDialog}');
  });
});
