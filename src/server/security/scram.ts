import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'crypto';

export function scramSha256Verifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();

  return `SCRAM-SHA-256$4096:${salt.toString('base64')}:${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
