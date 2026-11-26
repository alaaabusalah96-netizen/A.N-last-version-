import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(process.cwd(), 'src/server/routes/inventoryRoutes.ts'), 'utf8');
const start = src.indexOf("'/documents/jobs/:jobId'");
const block = src.slice(start, start + 1400);

describe('GET /documents/jobs/:jobId', () => {
  it('reads, then authorizes, and only then advances the job', () => {
    const iRead = block.indexOf('readJob(');
    const iAuth = block.indexOf('assertInventoryPermission(');
    const iAdvance = block.indexOf('advanceJob(');
    expect(iRead).toBeGreaterThan(-1);
    expect(iAuth).toBeGreaterThan(iRead);
    expect(iAdvance).toBeGreaterThan(iAuth);
  });
  it('never calls getJob (which advances) before the permission check', () => {
    expect(block).not.toContain('getJob(');
  });
});
