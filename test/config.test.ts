import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertTokenOrigin,
  configPath,
  loadConfig,
  resolveAuth,
  saveConfig,
} from '../src/core/config';

let dir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bq-cli-test-'));
  savedEnv = {
    BITQATE_CONFIG_DIR: process.env.BITQATE_CONFIG_DIR,
    BITQATE_TOKEN: process.env.BITQATE_TOKEN,
    BITQATE_PROFILE: process.env.BITQATE_PROFILE,
    BITQATE_API_URL: process.env.BITQATE_API_URL,
  };
  process.env.BITQATE_CONFIG_DIR = dir;
  delete process.env.BITQATE_TOKEN;
  delete process.env.BITQATE_PROFILE;
  delete process.env.BITQATE_API_URL;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('config', () => {
  test('saves with 0700 dir and 0600 file, readable again', () => {
    saveConfig({
      version: 1,
      current: 'default',
      profiles: { default: { api_url: 'https://x', token: 'tok' } },
    });
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    }
    const loaded = loadConfig();
    expect(loaded.current).toBe('default');
    expect(loaded.profiles.default.token).toBe('tok');
  });

  test('leaves no temp file after atomic write', () => {
    saveConfig({ version: 1, profiles: {} });
    const { readdirSync } = require('node:fs');
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  test('missing file yields empty config', () => {
    expect(loadConfig().profiles).toEqual({});
  });
});

describe('resolveAuth precedence', () => {
  test('env token wins over profile; flag > env > profile > default for URL', () => {
    const config = {
      version: 1 as const,
      current: 'p1',
      profiles: {
        p1: { api_url: 'https://profile.example', token: 'profile-tok' },
      },
    };
    expect(resolveAuth(config, {}).token).toBe('profile-tok');
    expect(resolveAuth(config, {}).source).toBe('profile');

    process.env.BITQATE_TOKEN = 'env-tok';
    expect(resolveAuth(config, {}).token).toBe('env-tok');
    expect(resolveAuth(config, {}).source).toBe('env');
    delete process.env.BITQATE_TOKEN;

    expect(resolveAuth(config, {}).apiUrl).toBe('https://profile.example');
    process.env.BITQATE_API_URL = 'https://env.example';
    process.env.BITQATE_TOKEN = 'env-tok';
    expect(resolveAuth(config, {}).apiUrl).toBe('https://env.example');
    expect(resolveAuth(config, { apiUrl: 'https://flag.example' }).apiUrl).toBe(
      'https://flag.example',
    );
    delete process.env.BITQATE_API_URL;
    delete process.env.BITQATE_TOKEN;

    process.env.BITQATE_PROFILE = 'p1';
    expect(resolveAuth(config, {}).profile).toBe('p1');
    expect(resolveAuth(config, { profile: 'other' }).profile).toBe('other');
  });

  test('resolveAuth reports the bound origin without throwing', () => {
    const config = {
      version: 1 as const,
      current: 'p1',
      profiles: {
        p1: { api_url: 'https://api.bitqate.com', token: 'profile-tok' },
      },
    };
    const auth = resolveAuth(config, { apiUrl: 'https://evil.example' });
    expect(auth.apiUrl).toBe('https://evil.example');
    expect(auth.boundUrl).toBe('https://api.bitqate.com');
    expect(auth.source).toBe('profile');

    process.env.BITQATE_TOKEN = 'env-tok';
    const envAuth = resolveAuth(config, { apiUrl: 'https://evil.example' });
    expect(envAuth.token).toBe('env-tok');
    expect(envAuth.boundUrl).toBeNull();
    delete process.env.BITQATE_TOKEN;
  });

  test('assertTokenOrigin only fires for profile tokens on a new origin', () => {
    const config = {
      version: 1 as const,
      current: 'p1',
      profiles: {
        p1: { api_url: 'https://api.bitqate.com', token: 'profile-tok' },
      },
    };
    expect(() =>
      assertTokenOrigin(
        resolveAuth(config, { apiUrl: 'https://evil.example' }),
      ),
    ).toThrowError(/bound to https:\/\/api\.bitqate\.com/);
    expect(() =>
      assertTokenOrigin(
        resolveAuth(config, { apiUrl: 'https://api.bitqate.com' }),
      ),
    ).not.toThrow();

    process.env.BITQATE_TOKEN = 'env-tok';
    expect(() =>
      assertTokenOrigin(
        resolveAuth(config, { apiUrl: 'https://evil.example' }),
      ),
    ).not.toThrow();
    delete process.env.BITQATE_TOKEN;
  });
});
