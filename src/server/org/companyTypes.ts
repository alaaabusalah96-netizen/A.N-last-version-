export interface Company {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string;
  isActive: boolean;
  createdAt: string;
  createdBy: string | null;
}

export interface CreateCompanyInput {
  code: string;
  nameAr: string;
  nameEn?: string;
  createdBy?: string | null;
}
