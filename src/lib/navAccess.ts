/**
 * Which sidebar sections a signed-in user may see.
 * Server-side checks stay the source of truth; this only hides what the user cannot use,
 * so a user with no permissions does not see a full menu that answers 403.
 */
export type NavKey =
  | 'companies'
  | 'accounting'
  | 'inventory'
  | 'purchasing'
  | 'sales'
  | 'cash'
  | 'fleet'
  | 'users'
  | 'roles'
  | 'org_units'
  | 'groups'
  | 'company_settings'
  | 'custom_fields'
  | 'config_platform'
  | 'config_definitions';

const ADMIN_ONLY: NavKey[] = ['config_platform', 'config_definitions'];

/** Any one of the listed permission codes opens the section. */
const NAV_PERMISSIONS: Record<Exclude<NavKey, 'config_platform' | 'config_definitions'>, string[]> = {
  companies: ['company:read'],
  accounting: ['accounting.accounts.read', 'accounting.journals.read'],
  inventory: ['inventory:read'],
  purchasing: ['purchasing:read'],
  sales: ['sales:read'],
  cash: ['cash:read', 'custody:request', 'custody:approve', 'custody:disburse', 'custody:settle'],
  fleet: ['fleet:read', 'fleet:manage', 'fleet:driver:self'],
  users: ['user:read'],
  roles: ['roles.read'],
  org_units: ['org:units:read'],
  groups: ['company:read', 'group:view'],
  company_settings: ['company:settings:read'],
  custom_fields: ['company:settings:read'],
};

export function canAccessNav(nav: NavKey, role: string | undefined, permissions: string[] | undefined): boolean {
  if (role === 'platform_admin') return true;
  if (ADMIN_ONLY.includes(nav)) return role === 'company_admin' && nav === 'config_platform';
  if (role === 'company_admin') return true;
  const needed = NAV_PERMISSIONS[nav as keyof typeof NAV_PERMISSIONS] || [];
  const have = permissions || [];
  return needed.some((p) => have.includes(p));
}

/** Can the user change company settings? Used to disable the form fields. */
export function canWriteCompanySettings(role: string | undefined, permissions: string[] | undefined): boolean {
  if (role === 'platform_admin' || role === 'company_admin') return true;
  return (permissions || []).includes('company:settings:write');
}
