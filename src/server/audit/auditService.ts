import { defaultAuditRepository, AuditRepository, AuditLogInput } from './auditRepository.js';

export class AuditService {
  constructor(private repo: AuditRepository = defaultAuditRepository) {}

  async record(input: AuditLogInput): Promise<void> {
    await this.repo.log(input);
  }
}

export const defaultAuditService = new AuditService();
