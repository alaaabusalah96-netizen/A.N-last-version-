import { getDefaultExecutor } from '../db/index.js';

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
  async log(input: AuditLogInput): Promise<void> {
    try {
      const executor = await getDefaultExecutor();
      if (!executor) return; // Silent skip if DB not configured in dev/non-DB mode

      const sql = `
        INSERT INTO audit_logs (actor_user_id, company_id, action, entity_type, entity_id, ip_address, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7);
      `;

      await executor.query(sql, [
        input.actorUserId || null,
        input.companyId || null,
        input.action,
        input.entityType || null,
        input.entityId || null,
        input.ipAddress || null,
        JSON.stringify(input.metadata || {}),
      ]);
    } catch (err) {
      console.error('[audit] Failed to write audit log:', err);
    }
  }
}

export const defaultAuditRepository = new AuditRepository();
