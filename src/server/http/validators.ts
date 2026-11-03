const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return UUID_REGEX.test(value);
}

export function isValidCompanyCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const trimmed = code.trim();
  if (trimmed.length < 1 || trimmed.length > 50) return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}
