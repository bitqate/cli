import { usageError } from './errors';

export const DEFAULT_API_URL = 'https://api.bitqate.com';
export const API_TOKEN_REGEX = /^bqat_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;

const CONTROL_CHARS = new RegExp('[\\x00-\\x1f\\x7f-\\x9f]');
const MAX_SEGMENT_LENGTH = 512;

export function isApiTokenFormat(token: string): boolean {
  return API_TOKEN_REGEX.test(token);
}

export function encodePathSegment(segment: string): string {
  if (!segment) throw usageError('Empty path segment');
  if (segment.length > MAX_SEGMENT_LENGTH)
    throw usageError('Path segment is too long');
  if (
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\')
  )
    throw usageError(`Invalid path segment '${segment}'`);
  if (CONTROL_CHARS.test(segment))
    throw usageError('Path segment contains control characters');
  return encodeURIComponent(segment);
}

export function buildApiPath(...segments: string[]): string {
  return `/v1/${segments.map(encodePathSegment).join('/')}`;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function validateApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`Invalid API URL '${raw}'`);
  }
  if (url.username || url.password)
    throw usageError('API URL must not contain credentials');
  if (url.search || url.hash)
    throw usageError('API URL must not contain a query or fragment');
  if (url.pathname !== '/' && url.pathname !== '')
    throw usageError('API URL must not contain a path');
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
    return url.origin;
  throw usageError(
    'API URL must use https (http is only allowed for localhost)',
  );
}

export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0)
      throw usageError(`Invalid --env value '${pair}': expected KEY=VALUE`);
    const key = pair.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw usageError(`Invalid environment variable name '${key}'`);
    out[key] = pair.slice(eq + 1);
  }
  return out;
}

const SSH_PUBLIC_KEY_REGEX =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;

export function validateSshPublicKey(content: string): string {
  const trimmed = content.trim();
  if (/PRIVATE KEY/.test(content))
    throw usageError(
      'The file looks like a private key. Pass a .pub public key file instead.',
    );
  if (trimmed.includes('\n'))
    throw usageError('SSH key file must contain a single public key line');
  if (trimmed.length > 4096 || !SSH_PUBLIC_KEY_REGEX.test(trimmed))
    throw usageError('Not a valid OpenSSH public key');
  const b64 = trimmed.split(' ')[1];
  try {
    const blob = Buffer.from(b64, 'base64');
    if (blob.length === 0) throw new Error('empty');
  } catch {
    throw usageError('Not a valid OpenSSH public key');
  }
  return trimmed;
}

export function cpusToUnits(value: string, flag: string): number {
  const cpus = Number(value);
  if (!Number.isFinite(cpus) || cpus <= 0)
    throw usageError(`--${flag} must be a positive number`);
  const units = Math.round(cpus * 100);
  if (units < 1)
    throw usageError(`--${flag} is too small (minimum 0.01 cores)`);
  return units;
}

export function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw usageError(`--${flag} must be a positive integer`);
  return n;
}
