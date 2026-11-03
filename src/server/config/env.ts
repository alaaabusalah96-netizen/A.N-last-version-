export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function isStrictEnv(): boolean {
  return process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';
}
