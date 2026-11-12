export type CustomFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select';
export type CustomEntityType = 'item' | 'supplier' | 'customer' | 'document';

export interface CustomFieldDefinition {
  id: string;
  companyId: string;
  entityType: CustomEntityType;
  fieldKey: string;
  labelAr: string;
  fieldType: CustomFieldType;
  options: string[] | null;
  isRequired: boolean;
  isActive: boolean;
  sortOrder: number;
  helpText: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateCustomFieldInput {
  entityType: CustomEntityType | string;
  fieldKey: string;
  labelAr: string;
  fieldType: CustomFieldType | string;
  options?: string[] | null;
  isRequired?: boolean;
  isActive?: boolean;
  sortOrder?: number;
  helpText?: string | null;
}

export interface UpdateCustomFieldInput {
  labelAr?: string;
  options?: string[] | null;
  isRequired?: boolean;
  isActive?: boolean;
  sortOrder?: number;
  helpText?: string | null;
}

export interface CustomFieldValueInput {
  fieldId: string;
  value: string | number | boolean | null;
}

export interface CustomFieldValueRecord {
  fieldId: string;
  fieldKey: string;
  labelAr: string;
  fieldType: CustomFieldType;
  options: string[] | null;
  value: string | number | boolean | null;
  isRequired: boolean;
  isActive: boolean;
  sortOrder: number;
  helpText: string | null;
}

export interface TypedCustomFieldValue {
  isEmpty: boolean;
  valueText: string | null;
  valueNumber: number | null;
  valueDate: string | null;
  valueBoolean: boolean | null;
}
