/**
 * Configuration Platform — Wave A types (AN-CONFIG-REGISTRY-A2-1 / A3 / A4).
 * Design source: docs/foundation/configuration-platform/03-DATA-MODEL-DRAFT.md
 */

export interface ConfigDefinition {
  id: string;
  key: string;
  domain: string;
  labelAr: string | null;
  isSystem: boolean;
  schema: Record<string, unknown>;
  defaultValue: Record<string, unknown>;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDefinitionInput {
  key: string;
  domain: string;
  labelAr?: string | null;
  description?: string | null;
  schema: Record<string, unknown>;
  defaultValue: Record<string, unknown>;
  isSystem?: boolean;
}

export interface UpdateDefinitionInput {
  labelAr?: string | null;
  description?: string | null;
  domain?: string;
}

export interface ConfigRegistryVersion {
  id: string;
  companyId: string;
  configDefinitionId: string;
  versionNo: number;
  isActive: boolean;
  content: Record<string, unknown>;
  changeSummary: string;
  publishedBy: string | null;
  publishedAt: string;
}

export interface ConfigDraft {
  id: string;
  companyId: string;
  configDefinitionId: string;
  status: 'draft' | 'in_review';
  content: Record<string, unknown>;
  updatedBy: string | null;
  updatedAt: string;
}

export interface ResolvedConfig {
  key: string;
  definitionId: string;
  source: 'company_published' | 'platform_default';
  versionNo: number | null;
  content: Record<string, unknown>;
}

export interface SaveDraftInput {
  content: Record<string, unknown>;
  status?: 'draft' | 'in_review';
}

export interface PublishDraftInput {
  changeSummary: string;
}

export interface RollbackInput {
  targetVersionNo: number;
  changeSummary: string;
}
