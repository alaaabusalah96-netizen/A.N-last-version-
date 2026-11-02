export interface Company {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
}

export interface CreateCompanyInput {
  code: string;
  nameAr: string;
  nameEn?: string;
  createdBy: string;
}
