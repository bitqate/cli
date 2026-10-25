import { describe, expect, test } from 'bun:test';
import { commands } from '../src/registry';
import { makeTheme } from '../src/ui/theme';
import '../src/commands/servers';

const theme = makeTheme(0, true);
const SRV_ID = 'aa11bb22-0000-0000-0000-000000000000';

const createCmd = commands.find(
  (c) => c.path.join(' ') === 'servers create',
)!;

function createCtx(extraFlags: Record<string, any> = {}) {
  const gets: string[][] = [];
  const ctx = {
    api: () => ({
      get: async (segs: string[]) => {
        gets.push(segs);
        if (segs[0] === 'daemons')
          return {
            daemons: [{ id: 'd1', name: 'ca-mo-01', location: 'Montreal' }],
          };
        if (segs[0] === 'servers' && segs[2] === 'install-state')
          return { installState: 'installed' };
        return {};
      },
      post: async (segs: string[], body: any) => ({ id: SRV_ID }),
    }),
    args: [] as string[],
    flags: {
      name: 'mc',
      region: 'ca-mo-01',
      'memory-mb': '2048',
      cpus: '1',
      'disk-gb': '10',
      ...extraFlags,
    },
    io: {
      json: false,
      quiet: false,
      yes: true,
      interactive: false,
      theme,
      verbose: false,
    },
    config: {} as any,
    auth: {} as any,
  } as any;
  return { ctx, gets };
}

function lines(result: any, io: any): string {
  return result.render(result.data, io).lines.join('\n');
}

function installStateCalls(gets: string[][]): number {
  return gets.filter((s) => s[0] === 'servers' && s[2] === 'install-state')
    .length;
}

describe('servers create', () => {
  test('returns right away while the game server is installing', async () => {
    const { ctx, gets } = createCtx({ game: 'paper' });
    const result = await createCmd.run(ctx);
    expect(result.data).toEqual({ id: SRV_ID, name: 'mc', mode: 'egg' });
    expect(installStateCalls(gets)).toBe(0);
    const out = lines(result, ctx.io);
    expect(out).toContain('mc is now being installed');
    expect(out).toContain(
      'Check progress with bitqate servers install-state mc',
    );
  });

  test('--wait polls install-state for a game server', async () => {
    const { ctx, gets } = createCtx({ game: 'paper', wait: true });
    const result = await createCmd.run(ctx);
    expect(installStateCalls(gets)).toBeGreaterThan(0);
    const out = lines(result, ctx.io);
    expect(out).toContain('mc is installed (');
  });

  test('--wait is ignored for non-egg modes', async () => {
    const { ctx, gets } = createCtx({
      image: 'nginx:latest',
      wait: true,
    });
    const result = await createCmd.run(ctx);
    const out = lines(result, ctx.io);
    expect(out).toContain('Created mc');
    expect(installStateCalls(gets)).toBe(0);
  });

  test('quotes names with spaces in the progress hint', async () => {
    const { ctx } = createCtx({ game: 'paper', name: 'my server' });
    const result = await createCmd.run(ctx);
    const out = lines(result, ctx.io);
    expect(out).toContain('bitqate servers install-state "my server"');
  });
});
