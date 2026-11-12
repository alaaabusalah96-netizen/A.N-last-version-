import { withTenantTransaction } from '../db/transactionManager.js';
import { getDefaultExecutor } from '../db/index.js';
import { DbExecutor } from '../db/types.js';
import {
  ConfigDefinition,
  ConfigRegistryVersion,
  ConfigDraft,
} from './configTypes.js';

export class ConfigRepository {
  // ---------------------------------------------------------------- definitions

  async listDefinitions(executor?: DbExecutor): Promise<ConfigDefinition[]> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          id,
          key,
          schema,
          default_value as "defaultValue",
          description,
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM config_definitions
        ORDER BY key ASC;
      `;
      const res = await ex.query<ConfigDefinition>(sql);
      return res.rows;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async findDefinitionByKey(key: string, executor?: DbExecutor): Promise<ConfigDefinition | null> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          id, key, schema,
          default_value as "defaultValue",
          description,
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM config_definitions
        WHERE key = $1;
      `;
      const res = await ex.query<ConfigDefinition>(sql, [key]);
      return res.rows[0] || null;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  // ------------------------------------------------------------------- registry

  async listActiveByCompany(companyId: string, executor?: DbExecutor): Promise<ConfigRegistryVersion[]> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          r.id,
          r.company_id as "companyId",
          r.config_definition_id as "configDefinitionId",
          r.version_no as "versionNo",
          r.is_active as "isActive",
          r.content,
          r.change_summary as "changeSummary",
          r.published_by as "publishedBy",
          r.published_at as "publishedAt"
        FROM config_registry r
        WHERE r.company_id = $1 AND r.is_active = true
        ORDER BY r.id;
      `;
      const res = await ex.query<ConfigRegistryVersion>(sql, [companyId]);
      return res.rows;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async findActive(companyId: string, definitionId: string, executor?: DbExecutor): Promise<ConfigRegistryVersion | null> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          r.id,
          r.company_id as "companyId",
          r.config_definition_id as "configDefinitionId",
          r.version_no as "versionNo",
          r.is_active as "isActive",
          r.content,
          r.change_summary as "changeSummary",
          r.published_by as "publishedBy",
          r.published_at as "publishedAt"
        FROM config_registry r
        WHERE r.company_id = $1 AND r.config_definition_id = $2 AND r.is_active = true;
      `;
      const res = await ex.query<ConfigRegistryVersion>(sql, [companyId, definitionId]);
      return res.rows[0] || null;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async findVersionByNo(
    companyId: string,
    definitionId: string,
    versionNo: number,
    executor?: DbExecutor
  ): Promise<ConfigRegistryVersion | null> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          r.id,
          r.company_id as "companyId",
          r.config_definition_id as "configDefinitionId",
          r.version_no as "versionNo",
          r.is_active as "isActive",
          r.content,
          r.change_summary as "changeSummary",
          r.published_by as "publishedBy",
          r.published_at as "publishedAt"
        FROM config_registry r
        WHERE r.company_id = $1 AND r.config_definition_id = $2 AND r.version_no = $3;
      `;
      const res = await ex.query<ConfigRegistryVersion>(sql, [companyId, definitionId, versionNo]);
      return res.rows[0] || null;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async listVersions(companyId: string, definitionId: string, executor?: DbExecutor): Promise<ConfigRegistryVersion[]> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          r.id,
          r.company_id as "companyId",
          r.config_definition_id as "configDefinitionId",
          r.version_no as "versionNo",
          r.is_active as "isActive",
          r.content,
          r.change_summary as "changeSummary",
          r.published_by as "publishedBy",
          r.published_at as "publishedAt"
        FROM config_registry r
        WHERE r.company_id = $1 AND r.config_definition_id = $2
        ORDER BY r.version_no DESC;
      `;
      const res = await ex.query<ConfigRegistryVersion>(sql, [companyId, definitionId]);
      return res.rows;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  /**
   * Publish = insert new immutable version row + flip is_active pointer.
   * The uniqueness constraint uq_config_registry_one_active guarantees a single
   * active row per company+definition; we deactivate the previous active first.
   */
  async insertPublishedVersion(
    companyId: string,
    definitionId: string,
    versionNo: number,
    content: Record<string, unknown>,
    changeSummary: string,
    publishedBy: string | null,
    executor?: DbExecutor
  ): Promise<ConfigRegistryVersion> {
    const run = async (ex: DbExecutor) => {
      await ex.query(
        `UPDATE config_registry SET is_active = false WHERE company_id = $1 AND config_definition_id = $2 AND is_active = true;`,
        [companyId, definitionId]
      );
      const res = await ex.query<ConfigRegistryVersion>(
        `
        INSERT INTO config_registry (
          company_id, config_definition_id, version_no, is_active, content, change_summary, published_by
        ) VALUES ($1, $2, $3, true, $4::jsonb, $5, $6)
        RETURNING
          id,
          company_id as "companyId",
          config_definition_id as "configDefinitionId",
          version_no as "versionNo",
          is_active as "isActive",
          content,
          change_summary as "changeSummary",
          published_by as "publishedBy",
          published_at as "publishedAt";
        `,
        [companyId, definitionId, versionNo, JSON.stringify(content), changeSummary, publishedBy]
      );
      return res.rows[0];
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async nextVersionNo(companyId: string, definitionId: string, executor?: DbExecutor): Promise<number> {
    const run = async (ex: DbExecutor) => {
      // قفل روی على مستوى (شركة × تعريف) داخل المعاملة الحالية.
      // بيمنع نشرين متزامنين من أخذ نفس version_no.
      await ex.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2));`,
        [companyId, definitionId]
      );

      const res = await ex.query<{ next: number }>(
        `SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM config_registry WHERE company_id = $1 AND config_definition_id = $2;`,
        [companyId, definitionId]
      );
      return Number(res.rows[0]?.next || 1);
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  // --------------------------------------------------------------------- drafts

  async findDraft(companyId: string, definitionId: string, executor?: DbExecutor): Promise<ConfigDraft | null> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          d.id,
          d.company_id as "companyId",
          d.config_definition_id as "configDefinitionId",
          d.status,
          d.content,
          d.updated_by as "updatedBy",
          d.updated_at as "updatedAt"
        FROM config_drafts d
        WHERE d.company_id = $1 AND d.config_definition_id = $2;
      `;
      const res = await ex.query<ConfigDraft>(sql, [companyId, definitionId]);
      return res.rows[0] || null;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async upsertDraft(
    companyId: string,
    definitionId: string,
    content: Record<string, unknown>,
    status: 'draft' | 'in_review',
    updatedBy: string | null,
    executor?: DbExecutor
  ): Promise<ConfigDraft> {
    const run = async (ex: DbExecutor) => {
      const res = await ex.query<ConfigDraft>(
        `
        INSERT INTO config_drafts (company_id, config_definition_id, status, content, updated_by, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
        ON CONFLICT (company_id, config_definition_id)
        DO UPDATE SET status = EXCLUDED.status, content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = NOW()
        RETURNING
          id,
          company_id as "companyId",
          config_definition_id as "configDefinitionId",
          status,
          content,
          updated_by as "updatedBy",
          updated_at as "updatedAt";
        `,
        [companyId, definitionId, status, JSON.stringify(content), updatedBy]
      );
      return res.rows[0];
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async deleteDraft(companyId: string, definitionId: string, executor?: DbExecutor): Promise<boolean> {
    const run = async (ex: DbExecutor) => {
      const res = await ex.query(
        `DELETE FROM config_drafts WHERE company_id = $1 AND config_definition_id = $2;`,
        [companyId, definitionId]
      );
      return res.rowCount > 0;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  private async defaultExecutor(): Promise<DbExecutor> {
    const executor = await getDefaultExecutor();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: DATABASE_URL is required for configuration platform operations');
    }
    return executor;
  }
}

export const defaultConfigRepository = new ConfigRepository();
