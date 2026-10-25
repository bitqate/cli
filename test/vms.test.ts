import { describe, expect, test } from 'bun:test';
import { commands } from '../src/registry';
import { sshInto } from '../src/commands/tools';
import { makeTheme } from '../src/ui/theme';
import '../src/commands/vms';

const theme = makeTheme(0, true);
const VM_ID = 'f1de2391-1c98-4497-afc1-ca20e310ad19';

const createCmd = commands.find((c) => c.path.join(' ') === 'vms create')!;
const getCmd = commands.find((c) => c.path.join(' ') === 'vms get')!;

function createCtx(getVm: () => any, extraFlags: Record<string, any> = {}) {
  const gets: string[][] = [];
  const ctx = {
    api: () => ({
      get: async (segs: string[]) => {
        gets.push(segs);
        if (segs[0] === 'vm-nodes')
          return {
            nodes: [{ id: 'n1', name: 'Montreal', nickname: 'montreal' }],
          };
        if (segs[0] === 'operating-systems')
          return {
            operating_systems: [
              { id: 'os1', name: 'Debian 12', node_ids: ['n1'] },
            ],
          };
        if (segs[0] === 'vms' && segs[1]) return { vm: getVm() };
        return {};
      },
      post: async (segs: string[], body: any) => ({
        vm: {
          id: VM_ID,
          name: body?.name ?? 'pending',
          status: 'creating',
          ip_address: '203.0.113.10',
        },
      }),
    }),
    args: [] as string[],
    flags: {
      node: 'montreal',
      os: 'debian 12',
      'memory-mb': '2048',
      cpus: '1',
      'disk-gb': '20',
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

describe('vms create', () => {
  test('returns right away while the VM is being created', async () => {
    const { ctx, gets } = createCtx(() => ({ id: VM_ID, status: 'creating' }));
    const result = await createCmd.run(ctx);
    expect(result.data.status).toBe('creating');
    expect(gets.some((s) => s[0] === 'vms' && s[1] === VM_ID)).toBe(false);
    const out = lines(result, ctx.io);
    expect(out).toContain(
      'VM f1de2391 is now being created · 203.0.113.10',
    );
    expect(out).toContain("You can't SSH in or manage it until it's done.");
    expect(out).toContain('Check progress with bitqate vms get f1de2391');
    expect(out).not.toContain('pending');
  });

  test('uses the chosen name in follow-up hints', async () => {
    const { ctx } = createCtx(
      () => ({ id: VM_ID, status: 'creating' }),
      { name: 'web-1' },
    );
    const result = await createCmd.run(ctx);
    const out = lines(result, ctx.io);
    expect(out).toContain('web-1 is now being created');
    expect(out).toContain('bitqate vms get web-1');
  });

  test('--wait polls and uses the final name', async () => {
    const { ctx } = createCtx(
      () => ({
        id: VM_ID,
        name: 'vm-123',
        status: 'active',
        ipv4: '203.0.113.10',
      }),
      { wait: true },
    );
    const result = await createCmd.run(ctx);
    expect(result.data.name).toBe('vm-123');
    const out = lines(result, ctx.io);
    expect(out).toContain('bitqate vms ssh vm-123');
    expect(out).not.toContain('pending');
  });
});

function sshCtx(vm: any, json: boolean) {
  return {
    api: () => ({ get: async () => ({ vm }) }),
    args: [] as string[],
    flags: {},
    io: { json, interactive: false, theme },
  } as any;
}

describe('vms ssh', () => {
  test('refuses while the VM is being created, in both modes', async () => {
    const vm = { id: VM_ID, name: 'pending', status: 'creating' };
    for (const json of [false, true]) {
      const err = await sshInto(sshCtx(vm, json), VM_ID).catch((e) => e);
      expect(err).toMatchObject({ code: 'conflict' });
      expect(err.message).toContain('is still being created');
      expect(err.message).toContain("You can SSH in once it's ready");
    }
  });

  test('refuses while the VM is being reinstalled', async () => {
    const vm = { id: VM_ID, name: 'web-1', status: 'reinstalling' };
    const err = await sshInto(sshCtx(vm, false), VM_ID).catch((e) => e);
    expect(err).toMatchObject({ code: 'conflict' });
    expect(err.message).toContain('is being reinstalled');
  });

  test('returns the SSH target in JSON mode when running', async () => {
    const vm = {
      id: VM_ID,
      name: 'web-1',
      status: 'running',
      ipv4: '203.0.113.10',
    };
    const result = await sshInto(sshCtx(vm, true), VM_ID);
    expect(result).toEqual({
      data: {
        host: '203.0.113.10',
        user: 'root',
        port: 22,
        host_key_fingerprint: null,
      },
    });
  });
});

describe('vms get', () => {
  function getCtx(vm: any) {
    return {
      api: () => ({ get: async () => ({ vm }) }),
      args: [VM_ID],
      flags: {},
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
  }

  test('hides the ssh hint while the VM is being created', async () => {
    const ctx = getCtx({ id: VM_ID, name: 'pending', status: 'creating' });
    const result = await getCmd.run(ctx);
    const hints = (result.render!(result.data, ctx.io) as any).detail
      .hints as [string, string][];
    expect(hints.some(([cmd]) => cmd.includes('vms ssh'))).toBe(false);
    expect(hints.some(([cmd]) => cmd.includes('open'))).toBe(true);
  });

  test('shows the ssh hint once the VM is running', async () => {
    const ctx = getCtx({ id: VM_ID, name: 'web-1', status: 'running' });
    const result = await getCmd.run(ctx);
    const hints = (result.render!(result.data, ctx.io) as any).detail
      .hints as [string, string][];
    expect(hints.some(([cmd]) => cmd.includes('vms ssh'))).toBe(true);
  });
});
