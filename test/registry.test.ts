import { describe, expect, spyOn, test } from 'bun:test';
import { commands } from '../src/registry';
import {
  destructiveGate,
  parseCommandLine,
  splitGlobalFlags,
  suggest,
} from '../src/core/args';
import { CliError } from '../src/core/errors';
import { sanitize, printJson, printQuiet } from '../src/core/output';
import { pollUntil } from '../src/core/poll';
import { main } from '../src/main';
import pkg from '../package.json';
import '../src/commands/auth';
import '../src/commands/account';
import '../src/commands/vms';
import '../src/commands/servers';
import '../src/commands/prices';
import '../src/commands/meta';

describe('registry', () => {
  test('every command has a scope declaration and summary', () => {
    expect(commands.length).toBeGreaterThan(30);
    for (const c of commands) {
      expect(c.scope === null || typeof c.scope === 'string').toBe(true);
      expect(c.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(c.examples)).toBe(true);
    }
  });

  test('no duplicate paths', () => {
    const seen = new Set(commands.map((c) => c.path.join(' ')));
    expect(seen.size).toBe(commands.length);
  });
});

describe('parseCommandLine', () => {
  const cmd = commands.find((c) => c.path.join(' ') === 'vms get')!;
  const create = commands.find((c) => c.path.join(' ') === 'vms create')!;

  test('unknown flag is a usage error with a suggestion', () => {
    try {
      parseCommandLine(cmd, ['--jso']);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe('usage');
      expect((e as CliError).message).toContain('--json');
    }
  });

  test('missing required arg and flag', () => {
    const authSwitch = commands.find(
      (c) => c.path.join(' ') === 'auth switch',
    )!;
    expect(() => parseCommandLine(authSwitch, [])).toThrow(CliError);
    const reinstall = commands.find(
      (c) => c.path.join(' ') === 'vms reinstall',
    )!;
    expect(() => parseCommandLine(reinstall, ['x'])).toThrow(CliError);
  });

  test('repeatable flags collect values', () => {
    const startup = commands.find(
      (c) => c.path.join(' ') === 'servers startup',
    )!;
    const { flags, positionals } = parseCommandLine(startup, [
      'srv1',
      '--env',
      'A=1',
      '--env',
      'B=2',
    ]);
    expect(flags.env).toEqual(['A=1', 'B=2']);
    expect(positionals).toEqual(['srv1']);
  });
});

describe('splitGlobalFlags', () => {
  test('global flags before the command are extracted', () => {
    expect(splitGlobalFlags(['--json', 'vms', 'list']).restArgv).toEqual([
      'vms',
      'list',
    ]);
    expect(splitGlobalFlags(['-q', 'servers', 'list']).restArgv).toEqual([
      'servers',
      'list',
    ]);
  });
  test('value-taking globals work in both forms', () => {
    const a = splitGlobalFlags([
      '--profile',
      'ci',
      '--api-url=http://x',
      'account',
    ]);
    expect(a.flagArgv).toEqual(['--profile', 'ci', '--api-url=http://x']);
    expect(a.restArgv).toEqual(['account']);
  });
  test('command flags and their values pass through untouched', () => {
    const a = splitGlobalFlags(['vms', 'create', '--node', 'pve-1']);
    expect(a.flagArgv).toEqual([]);
    expect(a.restArgv).toEqual(['vms', 'create', '--node', 'pve-1']);
  });
});

describe('printError modes', () => {
  test('JSON mode writes an error object, human mode writes error/hint lines', () => {
    const { printError } = require('../src/core/output');
    const err = new CliError('usage', 'nope\x07', { hint: 'pass --yes' });
    const out: string[] = [];
    const orig = process.stderr.write;
    (process.stderr as any).write = (s: string) => (out.push(s), true);
    try {
      printError(err, true);
      printError(err, false);
    } finally {
      (process.stderr as any).write = orig;
    }
    expect(JSON.parse(out[0])).toEqual({
      error: { code: 'usage', message: 'nope' },
    });
    expect(out[1]).toContain('nope');
    expect(out[2]).toContain('pass --yes');
  });
});

describe('destructiveGate', () => {
  test('yes proceeds, json/no-tty requires yes, tty prompts', () => {
    expect(destructiveGate({ json: false, yes: true, tty: true })).toBe(
      'proceed',
    );
    expect(destructiveGate({ json: true, yes: false, tty: true })).toBe(
      'require-yes',
    );
    expect(destructiveGate({ json: false, yes: false, tty: false })).toBe(
      'require-yes',
    );
    expect(destructiveGate({ json: false, yes: false, tty: true })).toBe(
      'prompt',
    );
  });
});

describe('output', () => {
  test('sanitize strips control chars incl. ESC', () => {
    expect(sanitize('a\x1b[31mb\x07c')).toBe('a[31mbc');
  });

  test('printJson writes the payload as-is', () => {
    const out: string[] = [];
    const orig = process.stdout.write;
    (process.stdout as any).write = (s: string) => (out.push(s), true);
    try {
      printJson({ a: 1 });
      printQuiet([{ id: 'x1' }, { id: 'x2' }]);
    } finally {
      (process.stdout as any).write = orig;
    }
    expect(out[0]).toBe(JSON.stringify({ a: 1 }, null, 2) + '\n');
    expect(out[1]).toBe('x1\n');
    expect(out[2]).toBe('x2\n');
  });
});

describe('main', () => {
  test('--version prints the version, with or without global flags', async () => {
    for (const argv of [['--version'], ['version'], ['--json', '--version']]) {
      const write = spyOn(process.stdout, 'write').mockImplementation(
        () => true,
      );
      let out = '';
      try {
        expect(await main(argv)).toBe(0);
        out = write.mock.calls.map(([s]) => String(s)).join('');
      } finally {
        write.mockRestore();
      }
      expect(out).toBe(`bitqate ${pkg.version}\n`);
    }
  });
});

describe('suggest', () => {
  test('finds near-misses', () => {
    expect(suggest('start', ['start', 'stop', 'status'])).toBe('start');
    expect(suggest('strt', ['start', 'stop'])).toBe('start');
    expect(suggest('zzzzzz', ['start'])).toBeNull();
  });
});

describe('pollUntil', () => {
  test('times out with exit code 9', async () => {
    const err = await pollUntil(async () => null, {
      intervalMs: 5,
      timeoutMs: 20,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('timeout');
    expect(err.exitCode).toBe(9);
  });

  test('returns when the check succeeds', async () => {
    let n = 0;
    const v = await pollUntil(async () => (++n >= 2 ? 'done' : null), {
      intervalMs: 1,
      timeoutMs: 1000,
    });
    expect(v).toBe('done');
  });
});
