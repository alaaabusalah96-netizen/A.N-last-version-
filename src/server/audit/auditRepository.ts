import { getDefaultExecutor } from '../db/index.js';
import { DbExecutor } from '../db/types.js';
import { AuditUnavailableError } from '../http/errors.js';

export interface AuditLogInput {
  actorUserId?: string | null;
  companyId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

export class AuditRepository {
  async log(input: AuditLogInput, customExecutor?: DbExecutor): Promise<void> {
    const executor = customExecutor || (await getDefaultExecutor());
    if (!executor) {
      throw new AuditUnavailableError('Database executor not available for audit logging');
    }

    const cleanMetadata = { ...input.metadata };
    delete (cleanMetadata as any).password;
    delete (cleanMetadata as any).token;
    delete (cleanMetadata as any).cookie;

    const userAgent = typeof cleanMetadata.userAgent === 'string' ? cleanMetadata.userAgent.substring(0, 200) : undefined;
    if (userAgent) {
      cleanMetadata.userAgent = userAgent;
    }

    const sql = `
      INSERT INTO audit_logs (actor_user_id, company_id, action, entity_type, entity_id, ip_address, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7);
    `;

    try {
      await executor.query(sql, [
        input.actorUserId || null,
        input.companyId || null,
        input.action,
        input.entityType || null,
        input.entityId || null,
        input.ipAddress || null,
        JSON.stringify(cleanMetadata),
      ]);
    } catch (err) {
      throw new AuditUnavailableError(`Failed to write audit record: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const defaultAuditRepository = new AuditRepository();
