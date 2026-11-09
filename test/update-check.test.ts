import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  finishUpdateCheck,
  isCompiledBinary,
  isNewer,
  readUpdateCheckCache,
  startUpdateCheck,
  updateCommand,
  updateCheckDisabled,
} from '../src/core/update-check';
import { makeTheme } from '../src/ui/theme';

describe('isNewer', () => {
  test('semver compare', () => {
    expect(isNewer('1.2.4', '1.2.3')).toBe(true);
    expect(isNewer('1.3.0', '1.2.9')).toBe(true);
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
    expect(isNewer('1.2.2', '1.2.3')).toBe(false);
    expect(isNewer('beta', '1.2.3')).toBe(false);
    expect(isNewer('1.2.3', 'x.y.z')).toBe(false);
  });
});

describe('updateCommand', () => {
  const no = () => false;
  test('node runtime → npm', () => {
    expect(updateCommand('/usr/bin/node', false, no)).toBe(
      'npm i -g @bitqate/cli@latest',
    );
  });
  test('uv tools → uv tool upgrade', () => {
    expect(
      updateCommand(
        '/home/u/.local/share/uv/tools/bitqate/bin/bitqate',
        true,
        no,
      ),
    ).toBe('uv tool upgrade bitqate');
  });
  test('uvx cache → uvx', () => {
    expect(
      updateCommand('/home/u/.cache/uv/archive-x/bin/bitqate', true, no),
    ).toBe('uvx bitqate@latest');
  });
  test('pipx → pipx upgrade', () => {
    expect(
      updateCommand('/home/u/.local/pipx/venvs/bitqate/bin/bitqate', true, no),
    ).toBe('pipx upgrade bitqate');
  });
  test('site-packages / venv → pip', () => {
    expect(
      updateCommand('/v/lib/python3.12/site-packages/bin/bitqate', true, no),
    ).toBe('pip install -U bitqate');
    expect(
      updateCommand('/home/u/proj/.venv/bin/bitqate', true, (p) =>
        p.endsWith('pyvenv.cfg'),
      ),
    ).toBe('pip install -U bitqate');
  });
  test('fallback → releases page', () => {
    expect(updateCommand('/opt/bitqate/bitqate', true, no)).toContain(
      'releases/latest',
    );
  });
});

describe('updateCheckDisabled', () => {
  const base = {
    env: {} as any,
    stderrTty: true,
    json: false,
    quiet: false,
    commandPath: ['servers'],
  };
  test('each skip condition', () => {
    expect(
      updateCheckDisabled({ ...base, env: { BITQATE_NO_UPDATE_CHECK: '1' } }),
    ).toBe(true);
    expect(updateCheckDisabled({ ...base, env: { CI: 'true' } })).toBe(true);
    expect(updateCheckDisabled({ ...base, stderrTty: false })).toBe(true);
    expect(updateCheckDisabled({ ...base, json: true })).toBe(true);
    expect(updateCheckDisabled({ ...base, quiet: true })).toBe(true);
    expect(updateCheckDisabled({ ...base, commandPath: ['completion'] })).toBe(
      true,
    );
    expect(updateCheckDisabled(base)).toBe(false);
  });
});

describe('isCompiledBinary', () => {
  test('bunfs entry means a compiled binary', () => {
    expect(isCompiledBinary('/$bunfs/root/bitqate', '1.4.4')).toBe(true);
    expect(isCompiledBinary('B:/~BUN/root/bitqate.exe', '1.4.4')).toBe(true);
    expect(
      isCompiledBinary(
        '/usr/lib/node_modules/@bitqate/cli/dist/bitqate.js',
        undefined,
      ),
    ).toBe(false);
    expect(isCompiledBinary('/home/u/cli/src/index.ts', '1.4.4')).toBe(false);
  });
});

describe('update check cache', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const theme = makeTheme(0, false);
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-update-'));
    prev = process.env.BITQATE_CONFIG_DIR;
    process.env.BITQATE_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.BITQATE_CONFIG_DIR;
    else process.env.BITQATE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fakeFetch = (body: unknown) => {
    const calls: string[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init?.headers as any)?.Authorization).toBeUndefined();
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    return { calls, impl };
  };

  test('fetches once, then stays quiet while the cache is fresh', async () => {
    const f = fakeFetch({ success: true, latest: '9.0.0' });
    const now = Date.now();
    expect(await startUpdateCheck(f.impl, now)).toBe('9.0.0');
    expect(f.calls).toEqual(['https://api.bitqate.com/public/cli/version']);
    expect(readUpdateCheckCache()?.latest).toBe('9.0.0');
    expect(startUpdateCheck(f.impl, now + 1000)).toBeNull();
    expect(f.calls).toHaveLength(1);
    expect(
      (fs.statSync(path.join(dir, 'update-check.json')).mode & 0o777).toString(
        8,
      ),
    ).toBe('600');
  });

  test('warns from the cache once per day', async () => {
    const f = fakeFetch({ success: true, latest: '9.0.0' });
    const now = Date.now();
    await startUpdateCheck(f.impl, now);
    const out: string[] = [];
    const write = (s: string) => out.push(s);
    await finishUpdateCheck({
      pending: null,
      current: '0.5.0',
      theme,
      now,
      write,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(
      'bitqate 9.0.0 is available (you have 0.5.0). Update:',
    );
    expect(readUpdateCheckCache()?.warnedAt).toBe(now);
    await finishUpdateCheck({
      pending: null,
      current: '0.5.0',
      theme,
      now: now + 1000,
      write,
    });
    expect(out).toHaveLength(1);
    await finishUpdateCheck({
      pending: null,
      current: '0.5.0',
      theme,
      now: now + DAY + 1,
      write,
    });
    expect(out).toHaveLength(2);
  });

  test('no warning when up to date', async () => {
    const f = fakeFetch({ success: true, latest: '0.5.0' });
    const out: string[] = [];
    await finishUpdateCheck({
      pending: startUpdateCheck(f.impl),
      current: '0.5.0',
      theme,
      write: (s) => out.push(s),
    });
    expect(out).toHaveLength(0);
  });

  test('a failing or slow request stays silent and is not retried for a day', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const now = Date.now();
    const out: string[] = [];
    await finishUpdateCheck({
      pending: startUpdateCheck(failing, now),
      current: '0.5.0',
      theme,
      write: (s) => out.push(s),
    });
    expect(out).toHaveLength(0);
    expect(readUpdateCheckCache()?.checkedAt).toBe(now);
    expect(startUpdateCheck(failing, now + 1000)).toBeNull();

    const slow = (() => new Promise(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    await finishUpdateCheck({
      pending: startUpdateCheck(slow, now + DAY + 1),
      current: '0.5.0',
      theme,
      waitMs: 50,
      write: (s) => out.push(s),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toHaveLength(0);
  });
});
