import { describe, expect, test } from 'bun:test';
import {
  buildApiPath,
  cpusToUnits,
  isApiTokenFormat,
  parseEnvPairs,
  validateApiUrl,
  validateSshPublicKey,
} from '../src/core/validate';
import { CliError } from '../src/core/errors';

const VALID_TOKEN = `bqat_${'a'.repeat(16)}_${'A'.repeat(43)}`;

describe('buildApiPath', () => {
  test('joins segments under /v1 and encodes them', () => {
    expect(buildApiPath('vms', 'vm 1')).toBe('/v1/vms/vm%201');
  });

  test('rejects traversal and empty segments', () => {
    for (const seg of ['..', '.', '', '../admin', 'a\\b']) {
      expect(() => buildApiPath('vms', seg)).toThrow(CliError);
    }
    expect(() => buildApiPath('../admin')).toThrow(CliError);
    expect(() => buildApiPath('')).toThrow(CliError);
  });

  test('rejects control characters and oversized segments', () => {
    expect(() => buildApiPath('vms', 'a\nb')).toThrow(CliError);
    expect(() => buildApiPath('vms', 'x'.repeat(513))).toThrow(CliError);
  });
});

describe('isApiTokenFormat', () => {
  test('accepts well-formed tokens only', () => {
    expect(isApiTokenFormat(VALID_TOKEN)).toBe(true);
    expect(isApiTokenFormat('bqat_bad')).toBe(false);
    expect(isApiTokenFormat(` ${VALID_TOKEN}`)).toBe(false);
    expect(isApiTokenFormat(`bqa_${'a'.repeat(16)}_${'A'.repeat(43)}`)).toBe(
      false,
    );
  });
});

describe('validateApiUrl', () => {
  test('accepts https and loopback http only', () => {
    expect(validateApiUrl('https://api.bitqate.com')).toBe(
      'https://api.bitqate.com',
    );
    expect(validateApiUrl('http://127.0.0.1:3000')).toBe(
      'http://127.0.0.1:3000',
    );
    expect(validateApiUrl('http://localhost:8080')).toBe(
      'http://localhost:8080',
    );
    expect(validateApiUrl('http://[::1]:8080')).toBe('http://[::1]:8080');
  });

  test('rejects http off loopback and URL extras', () => {
    for (const bad of [
      'http://example.com',
      'https://user:pw@api.bitqate.com',
      'https://api.bitqate.com/v1',
      'https://api.bitqate.com/?x=1',
      'https://api.bitqate.com/#f',
      'not a url',
    ]) {
      expect(() => validateApiUrl(bad)).toThrow(CliError);
    }
  });
});

describe('parseEnvPairs', () => {
  test('parses KEY=VALUE including = in values', () => {
    expect(parseEnvPairs(['A=1', 'B=a=b'])).toEqual({ A: '1', B: 'a=b' });
  });
  test('rejects malformed pairs', () => {
    expect(() => parseEnvPairs(['NOEQ'])).toThrow(CliError);
    expect(() => parseEnvPairs(['=v'])).toThrow(CliError);
    expect(() => parseEnvPairs(['9BAD=v'])).toThrow(CliError);
  });
});

describe('validateSshPublicKey', () => {
  const pub = `ssh-ed25519 ${Buffer.from('x'.repeat(64)).toString('base64')} comment`;
  test('accepts a single-line public key', () => {
    expect(validateSshPublicKey(`  ${pub}\n`)).toBe(pub);
  });
  test('refuses private keys without echoing them', () => {
    let err: CliError | null = null;
    try {
      validateSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nsecretstuff');
    } catch (e) {
      err = e as CliError;
    }
    expect(err).toBeInstanceOf(CliError);
    expect(err?.message).not.toContain('secretstuff');
  });
  test('rejects multiline and malformed keys', () => {
    expect(() => validateSshPublicKey(`${pub}\n${pub}`)).toThrow(CliError);
    expect(() => validateSshPublicKey('ssh-dss AAAA')).toThrow(CliError);
    expect(() => validateSshPublicKey('ssh-ed25519 !!!')).toThrow(CliError);
  });
});

describe('cpusToUnits', () => {
  test('converts fractional cores to units', () => {
    expect(cpusToUnits('1.5', 'cpus')).toBe(150);
    expect(cpusToUnits('2', 'cpus')).toBe(200);
  });
  test('rejects non-positive values', () => {
    expect(() => cpusToUnits('0', 'cpus')).toThrow(CliError);
    expect(() => cpusToUnits('-1', 'cpus')).toThrow(CliError);
    expect(() => cpusToUnits('abc', 'cpus')).toThrow(CliError);
  });
});
