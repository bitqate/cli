import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
  };
  process.env.BITQATE_CONFIG_DIR = dir;
  delete process.env.BITQATE_TOKEN;
  delete process.env.BITQATE_PROFILE;
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
      profiles: { default: { token: 'tok' } },
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
  test('env token wins over profile; profile precedence', () => {
    const config = {
      version: 1 as const,
      current: 'p1',
      profiles: {
        p1: { token: 'profile-tok' },
      },
    };
    expect(resolveAuth(config, {}).token).toBe('profile-tok');
    expect(resolveAuth(config, {}).source).toBe('profile');

    process.env.BITQATE_TOKEN = 'env-tok';
    expect(resolveAuth(config, {}).token).toBe('env-tok');
    expect(resolveAuth(config, {}).source).toBe('env');
    delete process.env.BITQATE_TOKEN;

    process.env.BITQATE_PROFILE = 'p1';
    expect(resolveAuth(config, {}).profile).toBe('p1');
    expect(resolveAuth(config, { profile: 'other' }).profile).toBe('other');
  });

  test('ignores BITQATE_API_URL and profile api_url', () => {
    process.env.BITQATE_API_URL = 'https://evil.example';
    const config = {
      version: 1 as const,
      current: 'p1',
      profiles: {
        p1: { api_url: 'https://evil.example', token: 'profile-tok' } as any,
      },
    };
    expect(resolveAuth(config, {})).toEqual({
      token: 'profile-tok',
      profile: 'p1',
      source: 'profile',
    });
    delete process.env.BITQATE_API_URL;
  });
});
