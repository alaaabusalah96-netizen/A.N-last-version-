import argon2 from 'argon2';

/**
 * Hash a plain text password using Argon2id
 */
export async function hashPassword(plain: string): Promise<string> {
  if (!plain) {
    throw new Error('Password cannot be empty');
  }
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  });
}

/**
 * Verify a plain text password against an Argon2id hash
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) {
    return false;
  }
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
