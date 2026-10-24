import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import {
  detectLevel,
  makeTheme,
  statusText,
  useUnicode,
} from '../src/ui/theme';
import {
  bytes,
  elapsed,
  memory,
  money,
  moneyMo,
  relTime,
  shortId,
  sizeLine,
  truncate,
} from '../src/ui/format';
import { renderTable } from '../src/ui/table';
import { priceMap, serverMonthly, vmMonthly } from '../src/core/pricing';
import {
  canonicalize,
  commandAliases,
  commands,
  findGroup,
} from '../src/registry';
import { password, confirm, select, text } from '../src/ui/prompts';
import { CliError } from '../src/core/errors';
import '../src/commands/auth';
import '../src/commands/account';
import '../src/commands/vms';
import '../src/commands/servers';
import '../src/commands/prices';
import '../src/commands/meta';
import '../src/commands/tools';

const theme = makeTheme(0, true);
const savedEnv: Record<string, string | undefined> = {};

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const keys = [
    'NO_COLOR',
    'FORCE_COLOR',
    'TERM',
    'COLORTERM',
    'WT_SESSION',
    'TERM_PROGRAM',
  ];
  for (const k of keys) savedEnv[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

describe('theme detection', () => {
  test('matrix', () => {
    withEnv({}, () => {
      expect(detectLevel({ isTTY: false })).toBe(0);
      expect(detectLevel({ isTTY: true })).toBe(1);
    });
    withEnv({ NO_COLOR: '1', COLORTERM: 'truecolor' }, () => {
      expect(detectLevel({ isTTY: true })).toBe(0);
    });
    withEnv({ FORCE_COLOR: '0' }, () =>
      expect(detectLevel({ isTTY: true })).toBe(0),
    );
    withEnv({ FORCE_COLOR: '3' }, () =>
      expect(detectLevel({ isTTY: false })).toBe(3),
    );
    withEnv({ FORCE_COLOR: '1', NO_COLOR: '1' }, () =>
      expect(detectLevel({ isTTY: true })).toBe(1),
    );
    withEnv({ TERM: 'dumb' }, () =>
      expect(detectLevel({ isTTY: true })).toBe(0),
    );
    withEnv({ COLORTERM: 'truecolor' }, () =>
      expect(detectLevel({ isTTY: true })).toBe(3),
    );
    withEnv({ WT_SESSION: 'x' }, () =>
      expect(detectLevel({ isTTY: true })).toBe(3),
    );
    withEnv({ TERM_PROGRAM: 'iTerm.app' }, () =>
      expect(detectLevel({ isTTY: true })).toBe(3),
    );
  });

  test('status tones and glyphs', () => {
    const t3 = makeTheme(3, true);
    expect(t3.statusTone('running')).toBe('success');
    expect(t3.statusTone('installing')).toBe('progress');
    expect(t3.statusTone('suspended')).toBe('warning');
    expect(t3.statusTone('failed')).toBe('danger');
    expect(t3.statusTone('offline')).toBe('muted');
    expect(statusText(t3, 'running')).toContain('running');
    expect(makeTheme(1, false).glyph('check')).toBe('+');
    expect(makeTheme(1, true).spinnerFrames()[0]).toBe('⠋');
    expect(makeTheme(1, false).spinnerFrames()[1]).toBe('\\');
  });
});

describe('format helpers', () => {
  test('money and sizes', () => {
    expect(money(224.85)).toBe('$224.85');
    expect(moneyMo(7.9)).toBe('$7.90/mo');
    expect(memory(512)).toBe('512 MB');
    expect(memory(2048)).toBe('2 GB');
    expect(sizeLine(2, 2048, 40)).toBe('2 vCPU · 2 GB · 40 GB');
    expect(bytes(1468006)).toBe('1.4 MB');
    expect(shortId('f1de2391-1c98')).toBe('f1de2391');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(elapsed(72)).toBe('1:12');
  });

  test('relative time', () => {
    const now = new Date('2026-01-15T00:00:00Z');
    expect(relTime('2026-01-14T23:59:50Z', now)).toBe('just now');
    expect(relTime('2026-01-14T23:55:00Z', now)).toBe('5 min ago');
    expect(relTime('2026-01-12T00:00:00Z', now)).toBe('3 days ago');
    expect(relTime('2026-01-27T00:00:00Z', now)).toBe('in 12 days');
    expect(relTime(1769040000, now)).toContain('day');
  });
});

describe('table', () => {
  const table = {
    columns: [
      { title: 'Name', truncate: true },
      { title: 'ID', priority: 1 },
      { title: 'Status', priority: 8 },
    ],
    rows: [
      ['dizzy-puma', 'f1de2391', 'running'],
      ['a-very-long-name-indeed', 'aa11bb22', 'stopped'],
    ],
    footer: '2 VMs · 1 running',
  };

  test('drops lowest priority columns when narrow', () => {
    const wide = renderTable(table, theme, { tty: true, width: 80 });
    expect(wide).toContain('ID');
    const narrow = renderTable(table, theme, { tty: true, width: 20 });
    expect(narrow).not.toContain('ID');
    expect(narrow).toContain('STATUS');
  });

  test('non-tty is plain with full values', () => {
    const out = renderTable(table, theme, { tty: false });
    expect(out).toContain('a-very-long-name-indeed');
    expect(out).toContain('f1de2391');
    expect(out).not.toContain('\x1b[');
  });
});

describe('pricing', () => {
  const prices = priceMap([
    { key: 'ram-vps', price: 0.6 },
    { key: 'cpu-vps', price: 1.75 },
    { key: 'disk-vps', price: 0.03 },
    { key: 'ip-vps', price: 2 },
    { key: 'ram-game', price: 0.6 },
    { key: 'cpu-game', price: 1.75 },
    { key: 'disk-game', price: 0.03 },
  ]);

  test('vm monthly', () => {
    expect(
      vmMonthly({ memory_mb: 2048, cpus: 2, disk_gb: 40, ipv4: true }, prices),
    ).toBeCloseTo(7.9, 5);
    expect(
      vmMonthly({ memory_mb: 2048, cpus: 2, disk_gb: 40, ipv4: false }, prices),
    ).toBeCloseTo(5.9, 5);
  });

  test('server monthly', () => {
    const raw = serverMonthly(
      { ram_mb: 512, cpu_units: 50, disk_gb: 5 },
      prices,
    );
    expect(raw).toBeCloseTo(1.325, 5);
    expect(money(raw!)).toBe('$1.32');
  });

  test('missing keys return null', () => {
    expect(
      vmMonthly({ memory_mb: 1, cpus: 1, disk_gb: 1, ipv4: true }, {}),
    ).toBeNull();
  });
});

describe('aliases', () => {
  test('group and subcommand aliases canonicalize', () => {
    expect(canonicalize(['vm', 'ls'])).toEqual(['vms', 'list']);
    expect(canonicalize(['srv', 'rm'])).toEqual(['servers', 'delete']);
    expect(canonicalize(['whoami'])).toEqual(['account']);
    expect(canonicalize(['vms', 'show'])).toEqual(['vms', 'get']);
    expect(canonicalize(['servers', 'new'])).toEqual(['servers', 'create']);
    expect(findGroup(['server'])).toBeTruthy();
    expect(
      commandAliases(commands.find((c) => c.path.join(' ') === 'vms list')!),
    ).toContain('ls');
  });
});

function ioWith(keys: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = '';
  output.on('data', (c) => (captured += c.toString()));
  const io = { input, output };
  queueMicrotask(() => {
    input.write(keys);
    input.end();
  });
  return { io, captured: () => captured };
}

describe('prompts', () => {
  test('select navigates with arrows and returns the value', async () => {
    const { io } = ioWith('\x1b[B\x1b[B\r');
    const v = await select(
      {
        message: 'Pick',
        options: [
          { label: 'a', value: 1 },
          { label: 'b', value: 2 },
          { label: 'c', value: 3 },
        ],
        io,
      },
      theme,
    );
    expect(v).toBe(3);
  });

  test('select filters when many options', async () => {
    const { io } = ioWith('b\r');
    const v = await select(
      {
        message: 'Pick',
        options: Array.from({ length: 12 }, (_, i) => ({
          label: `opt-${i === 5 ? 'bee' : i}`,
          value: i,
        })),
        io,
      },
      theme,
    );
    expect(v).toBe(5);
  });

  test('select cancels on escape', async () => {
    const { io } = ioWith('\x1b');
    await expect(
      select({ message: 'x', options: [{ label: 'a', value: 1 }], io }, theme),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  test('text accepts the default on enter and validates', async () => {
    const { io } = ioWith('\r');
    const v = await text({ message: 'Name', default: 'api', io }, theme);
    expect(v).toBe('api');

    const bad = ioWith('!!\x7f\x7f\r');
    const v2 = await text(
      {
        message: 'Name',
        io: bad.io,
        validate: (s) => (/[^a-z]/.test(s) ? 'bad chars' : null),
      },
      theme,
    );
    expect(v2).toBe('');
  });

  test('confirm honours default and y/n', async () => {
    expect(
      await confirm(
        { message: 'ok', default: true, io: ioWith('\r').io },
        theme,
      ),
    ).toBe(true);
    expect(
      await confirm(
        { message: 'ok', default: true, io: ioWith('n').io },
        theme,
      ),
    ).toBe(false);
  });

  test('password collects without echoing plaintext length', async () => {
    const { io, captured } = ioWith('s3cret\r');
    const v = await password({ message: 'Token', io }, theme);
    expect(v).toBe('s3cret');
    expect(captured()).toContain('••••••');
    expect(captured()).not.toContain('s3cret');
  });
});

describe('non-tty contract', () => {
  test('missing required flags stay usage errors', async () => {
    const create = commands.find((c) => c.path.join(' ') === 'vms create')!;
    const ctx: any = {
      api: () => {
        throw new CliError('unauthenticated', 'no');
      },
      args: [],
      flags: {},
      io: {
        json: false,
        quiet: false,
        yes: false,
        interactive: false,
        theme,
        verbose: false,
      },
      auth: {} as any,
      config: {} as any,
    };
    await expect(create.run(ctx)).rejects.toThrow();
  });
});

describe('command help placeholders', () => {
  test('no <value> placeholder remains in any command help', async () => {
    const { commandHelp } = await import('../src/ui/help');
    for (const cmd of commands) {
      const out = commandHelp(cmd, theme);
      expect(out).not.toContain('<value>');
    }
  });
});
