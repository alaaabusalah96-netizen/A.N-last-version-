import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(process.cwd(), 'src/server/routes/inventoryRoutes.ts'), 'utf8');
const start = src.indexOf("'/documents/jobs/:jobId'");
const block = src.slice(start, start + 2600);

describe('GET /documents/jobs/:jobId', () => {
  it('authorizes, then reads, and only then advances the job', () => {
    const iRead = block.indexOf('readJob(');
    const iAuth = block.indexOf('INVENTORY_MOVEMENT');
    const iAdvance = block.indexOf('advanceJob(');
    expect(iRead).toBeGreaterThan(-1);
    expect(iAuth).toBeGreaterThan(-1);
    expect(iRead).toBeGreaterThan(iAuth);
    expect(iAdvance).toBeGreaterThan(iRead);
  });
  it('a missing job and a job the caller may not touch give the same 404', () => {
    expect(block).toContain('!existing || !allowedForType');
  });
  it('never calls getJob (which advances) before the permission check', () => {
    expect(block).not.toContain('getJob(');
  });
});
