import { defaultAuditRepository, AuditRepository, AuditLogInput } from './auditRepository.js';
import { DbExecutor } from '../db/types.js';

export interface AuditRecordOptions {
  mode?: 'required' | 'best_effort';
  executor?: DbExecutor;
}

export class AuditService {
  constructor(private repo: AuditRepository = defaultAuditRepository) {}

  async record(input: AuditLogInput, options: AuditRecordOptions = {}): Promise<void> {
    const mode = options.mode || 'required';
    try {
      await this.repo.log(input, options.executor);
    } catch (err) {
      console.error('[audit] Audit logging error:', err);
      if (mode === 'required') {
        throw err;
      }
    }
  }
}

export const defaultAuditService = new AuditService();
