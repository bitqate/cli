import { describe, expect, test } from 'bun:test';
import { resolveResource } from '../src/core/resolve';
import { CliError } from '../src/core/errors';
import { openUrl, portalUrl } from '../src/core/portal';
import { makeTheme } from '../src/ui/theme';

const theme = makeTheme(0, true);

const VMS = [
  { id: 'f1de2391-1c98-4497-afc1-ca20e310ad19', name: 'dizzy-puma' },
  { id: 'aa11bb22-0000-0000-0000-000000000000', name: 'web-1' },
  { id: 'aa11bb23-0000-0000-0000-000000000000', name: 'web-2' },
];

function ctxWith(list: any[] | CliError, interactive = false) {
  return {
    api: () => ({
      get: async () => {
        if (list instanceof CliError) throw list;
        return { vms: list };
      },
    }),
    io: { interactive, json: false },
    args: [],
    flags: {},
    auth: {} as any,
    config: {} as any,
  } as any;
}

describe('resolveResource', () => {
  test('UUID fast path makes no list call', async () => {
    const r = await resolveResource(
      ctxWith(new CliError('server', 'should not be called')),
      'vms',
      VMS[0].id,
      theme,
    );
    expect(r.id).toBe(VMS[0].id);
  });

  test('exact name and unique prefix resolve', async () => {
    expect(
      (await resolveResource(ctxWith(VMS), 'vms', 'dizzy-puma', theme)).id,
    ).toBe(VMS[0].id);
    expect(
      (await resolveResource(ctxWith(VMS), 'vms', 'Dizzy-Puma', theme)).id,
    ).toBe(VMS[0].id);
    expect(
      (await resolveResource(ctxWith(VMS), 'vms', 'f1de2391', theme)).id,
    ).toBe(VMS[0].id);
  });

  test('no match is not_found with the list hint', async () => {
    const err = await resolveResource(ctxWith(VMS), 'vms', 'nope', theme).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('not_found');
    expect(err.message).toContain("No VM matches 'nope'");
  });

  test('ambiguous non-tty lists candidates', async () => {
    const err = await resolveResource(
      ctxWith(VMS),
      'vms',
      'aa11bb',
      theme,
    ).catch((e) => e);
    expect(err.code).toBe('usage');
    expect(err.message).toContain('web-1');
    expect(err.message).toContain('aa11bb22');
  });

  test('403 on the list call explains the scope requirement', async () => {
    const err = await resolveResource(
      ctxWith(new CliError('forbidden', 'nope', { status: 403 })),
      'vms',
      'dizzy-puma',
      theme,
    ).catch((e) => e);
    expect(err.code).toBe('forbidden');
    expect(err.message).toContain('vms:read');
    expect(err.message).toContain('full ID');
  });
});

describe('portal', () => {
  test('portalUrl builds vm/server/home URLs and validates override', () => {
    expect(portalUrl('vm', 'abc')).toBe('https://portal.bitqate.com/vm/abc');
    expect(portalUrl('server', 'abc')).toBe(
      'https://portal.bitqate.com/server/abc',
    );
    expect(portalUrl('home')).toBe('https://portal.bitqate.com');
    const saved = process.env.BITQATE_PORTAL_URL;
    process.env.BITQATE_PORTAL_URL = 'http://evil.example';
    expect(() => portalUrl('home')).toThrow(CliError);
    if (saved === undefined) delete process.env.BITQATE_PORTAL_URL;
    else process.env.BITQATE_PORTAL_URL = saved;
  });

  test('openUrl refuses unsafe URLs before spawning', async () => {
    const e1 = await openUrl('javascript:alert(1)').catch((e) => e);
    expect(e1.code).toBe('usage');
    const e2 = await openUrl('https://x.com/$(rm -rf /)').catch((e) => e);
    expect(e2.code).toBe('usage');
  });
});

describe('resolveOption', () => {
  const nodes = [
    { id: 'n1', name: 'Cologix MTL2', nickname: 'montreal' },
    { id: 'n2', name: 'OVH GRAV', nickname: 'grav' },
  ];
  function ctx(list: any) {
    return { api: () => ({ get: async () => ({ nodes: list }) }) } as any;
  }
  test('matches id, name or nickname case-insensitively', async () => {
    const { resolveOption } = await import('../src/core/resolve');
    expect(await resolveOption(ctx(nodes), ['vm-nodes'], 'n1', ['id'], 'node')).toBe('n1');
    expect(await resolveOption(ctx(nodes), ['vm-nodes'], 'Montreal', ['nickname'], 'node')).toBe('n1');
    expect(await resolveOption(ctx(nodes), ['vm-nodes'], 'cologix mtl2', ['name'], 'node')).toBe('n1');
  });
  test('zero or several matches give a usage error listing choices', async () => {
    const { resolveOption } = await import('../src/core/resolve');
    const e1 = await resolveOption(ctx(nodes), ['vm-nodes'], 'nowhere', ['name'], 'node').catch((e) => e);
    expect(e1.code).toBe('usage');
    expect(e1.message).toContain('Cologix');
    const both = await resolveOption(ctx(nodes), ['vm-nodes'], 'ovh grav', ['name', 'nickname'], 'node').catch((e) => e);
    expect(both).toBe('n2');
  });
});
