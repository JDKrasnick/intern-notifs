const DEFAULT_CHALLENGE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface EmployerChallenge {
  tokenHash: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export type ChallengeCheck = 'valid' | 'expired' | 'replayed' | 'mismatch';

export type ChallengeCrypto = Pick<Crypto, 'getRandomValues' | 'subtle'>;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashChallengeToken(token: string, cryptoProvider: ChallengeCrypto = crypto): Promise<string> {
  const digest = await cryptoProvider.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return base64Url(new Uint8Array(digest));
}

export async function createEmployerChallenge(options: {
  now?: Date;
  ttlMs?: number;
  cryptoProvider?: ChallengeCrypto;
} = {}): Promise<{ token: string; challenge: EmployerChallenge }> {
  const cryptoProvider = options.cryptoProvider ?? crypto;
  const random = cryptoProvider.getRandomValues(new Uint8Array(32));
  const token = base64Url(random);
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Challenge TTL must be a positive integer');
  return {
    token,
    challenge: {
      tokenHash: await hashChallengeToken(token, cryptoProvider),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    },
  };
}

function equalHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function checkEmployerChallenge(
  challenge: EmployerChallenge,
  token: string,
  now = new Date(),
  cryptoProvider: ChallengeCrypto = crypto,
): Promise<ChallengeCheck> {
  if (challenge.consumedAt) return 'replayed';
  if (!Number.isFinite(Date.parse(challenge.expiresAt)) || now.getTime() >= Date.parse(challenge.expiresAt)) return 'expired';
  const suppliedHash = await hashChallengeToken(token, cryptoProvider);
  return equalHash(challenge.tokenHash, suppliedHash) ? 'valid' : 'mismatch';
}

export function consumeEmployerChallenge(challenge: EmployerChallenge, now = new Date()): EmployerChallenge {
  if (challenge.consumedAt) throw new Error('Challenge has already been consumed');
  if (!Number.isFinite(Date.parse(challenge.expiresAt)) || now.getTime() >= Date.parse(challenge.expiresAt)) {
    throw new Error('Challenge has expired');
  }
  return { ...challenge, consumedAt: now.toISOString() };
}
