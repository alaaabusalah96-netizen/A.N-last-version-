export function displayRoleLabel(role: string): string {
  if (!role) return 'مستخدم';
  const normalized = role.trim().toLowerCase();
  switch (normalized) {
    case 'platform_admin':
      return 'مدير المنصة';
    case 'company_admin':
      return 'مدير الشركة';
    case 'accountant':
      return 'محاسب';
    case 'member':
    case 'user':
      return 'عضو';
    default:
      return 'دور تشغيلي';
  }
}
