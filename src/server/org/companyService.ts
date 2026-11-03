import { defaultCompanyRepository, CompanyRepository } from './companyRepository.js';
import { defaultMembershipRepository, MembershipRepository } from './membershipRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { getDefaultExecutor } from '../db/index.js';
import { DbExecutor } from '../db/types.js';
import { Company, CreateCompanyInput } from './companyTypes.js';

export interface CreateCompanyDependencies {
  companyRepo?: CompanyRepository;
  membershipRepo?: MembershipRepository;
  auditService?: AuditService;
  getExecutor?: () => Promise<DbExecutor | null>;
}

export class CompanyService {
  async createCompanyWithAdmin(
    input: CreateCompanyInput,
    actorUserId: string,
    ipAddress?: string,
    deps: CreateCompanyDependencies = {}
  ): Promise<Company> {
    const companyRepo = deps.companyRepo || defaultCompanyRepository;
    const membershipRepo = deps.membershipRepo || defaultMembershipRepository;
    const auditService = deps.auditService || defaultAuditService;
    const getExecutor = deps.getExecutor || getDefaultExecutor;

    const executor = await getExecutor();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: Database executor required to create company');
    }

    let createdCompany: Company | undefined;

    await executor.withTransaction(async (tx) => {
      // 1. Create company record
      createdCompany = await companyRepo.create(input, tx);

      // 2. Grant creator company_admin membership
      await membershipRepo.addMember(actorUserId, createdCompany.id, 'company_admin', true, tx);

      // 3. Record audit log (Required mode inside transaction)
      await auditService.record(
        {
          actorUserId,
          companyId: createdCompany.id,
          action: 'company.create',
          entityType: 'company',
          entityId: createdCompany.id,
          ipAddress: ipAddress || 'unknown',
          metadata: { code: createdCompany.code, nameAr: createdCompany.nameAr },
        },
        { mode: 'required', executor: tx }
      );
    });

    return createdCompany!;
  }
}

export const defaultCompanyService = new CompanyService();
