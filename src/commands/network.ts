import { isIP } from 'node:net';
import { CliError, usageError } from '../core/errors';
import { sanitize } from '../core/output';
import { openUrl, portalUrl } from '../core/portal';
import { resolveResource } from '../core/resolve';
import { register, type RunContext } from '../registry';
import { confirm, select, text } from '../ui/prompts';
import { task } from '../ui/spinner';
import type { Theme } from '../ui/theme';

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;

const RESOLVER_PRESETS: { label: string; value: string; hint: string }[] = [
  { label: 'Cloudflare', value: '1.1.1.1 1.0.0.1', hint: '1.1.1.1, 1.0.0.1' },
  { label: 'Google', value: '8.8.8.8 8.8.4.4', hint: '8.8.8.8, 8.8.4.4' },
  {
    label: 'Quad9',
    value: '9.9.9.9 149.112.112.112',
    hint: '9.9.9.9, 149.112.112.112',
  },
];

interface IpRow {
  address: string;
  version: number;
  is_primary?: boolean;
  cidr?: string | null;
  gateway?: string | null;
  rdns?: string | null;
  nameservers?: string | null;
  host_addresses?: number;
}

function check(theme: Theme, msg: string): string {
  return `${theme.paint('success', theme.glyph('check'))} ${msg}`;
}

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function resolveVm(ctx: RunContext) {
  return resolveResource(ctx, 'vms', ctx.args[0], ctx.io.theme);
}

async function loadIps(ctx: RunContext, id: string): Promise<IpRow[]> {
  const resp = await ctx.api().get(['vms', id, 'networking']);
  return Array.isArray(resp?.ips) ? resp.ips : [];
}

function validHostname(v: string): string | null {
  return HOSTNAME_RE.test(v.trim())
    ? null
    : 'Enter a full hostname like mail.example.com';
}

function parseResolvers(v: string): string | null {
  const parts = v
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 3) return null;
  if (!parts.every((p) => isIP(p))) return null;
  return parts.join(' ');
}

function ipTable(theme: Theme, ips: IpRow[]): string[] {
  if (!ips.length)
    return [theme.paint('muted', '  No IP addresses assigned yet.')];
  const rows = ips.map((ip) => {
    const kind =
      ip.version === 6
        ? `IPv6 /${ip.cidr ?? '64'}${ip.host_addresses ? ` · ${ip.host_addresses} host${ip.host_addresses === 1 ? '' : 's'}` : ''}`
        : `IPv4${ip.is_primary ? ' · primary' : ''}`;
    return [
      ip.address,
      kind,
      ip.version === 6 ? '' : (ip.rdns ?? ''),
      ip.version === 6 ? '' : (ip.nameservers ?? ''),
    ];
  });
  const head = ['Address', 'Type', 'rDNS', 'DNS resolvers'];
  const w = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (r: string[]) =>
    `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ')}`.trimEnd();
  return [
    theme.paint('muted', fmt(head)),
    ...rows.map((r) =>
      fmt(
        r.map((c, i) =>
          c ? sanitize(c) : i >= 2 ? theme.paint('muted', '-') : c,
        ),
      ),
    ),
  ];
}

async function pickIpv4(
  theme: Theme,
  ips: IpRow[],
  purpose: string,
): Promise<IpRow | null> {
  const v4 = ips.filter((i) => i.version === 4);
  if (!v4.length) {
    say(theme.paint('muted', '  This VM has no IPv4 address.'));
    return null;
  }
  if (v4.length === 1) return v4[0];
  const address = await select<string>(
    {
      message: `Which address ${purpose}?`,
      label: 'Address',
      options: v4.map((i) => ({
        label: i.address,
        value: i.address,
        hint: [i.is_primary ? 'primary' : '', i.rdns ?? '']
          .filter(Boolean)
          .join(' · '),
      })),
    },
    theme,
  );
  return v4.find((i) => i.address === address) ?? null;
}

async function putRdns(
  ctx: RunContext,
  id: string,
  address: string,
  hostname: string | null,
  ipv6: boolean,
) {
  const segments = ipv6
    ? ['vms', id, 'networking', 'ipv6', 'addresses', 'rdns']
    : ['vms', id, 'networking', 'rdns'];
  return task(
    hostname ? `Setting rDNS for ${address}` : `Clearing rDNS for ${address}`,
    ctx.io.theme,
    () => ctx.api().put(segments, { address, rdns: hostname }),
  );
}

function rdnsDone(
  theme: Theme,
  address: string,
  hostname: string | null,
  synced: unknown,
): string[] {
  const lines = [
    hostname
      ? check(theme, `${address} now points back to ${sanitize(hostname)}`)
      : check(theme, `Cleared rDNS for ${address}`),
  ];
  if (synced === false)
    lines.push(
      theme.paint(
        'muted',
        '  Saved. It can take a few minutes before lookups show it.',
      ),
    );
  return lines;
}

async function interactiveRdns(ctx: RunContext, id: string, ips: IpRow[]) {
  const theme = ctx.io.theme;
  const ip = await pickIpv4(theme, ips, 'should get rDNS');
  if (!ip) return;
  say(
    theme.paint(
      'muted',
      `  Reverse DNS makes ${ip.address} resolve to a hostname (mail servers need this).\n  First add an A record for the hostname pointing to ${ip.address}; BitQate checks it before saving.`,
    ),
  );
  const current = ip.rdns ?? '';
  const value = await text(
    {
      message: current
        ? `Hostname (now ${current}, blank to clear)`
        : 'Hostname',
      label: 'rDNS',
      blankLabel: current ? 'clear' : 'unchanged',
      validate: (v) => (!v.trim() ? null : validHostname(v)),
    },
    theme,
  );
  const hostname = value.trim().replace(/\.$/, '') || null;
  if (!hostname && !current) return;
  if (hostname === current) return;
  const resp = await putRdns(ctx, id, ip.address, hostname, false);
  for (const l of rdnsDone(theme, ip.address, hostname, resp?.dnsSynced))
    say(l);
}

async function interactiveResolvers(ctx: RunContext, id: string, ips: IpRow[]) {
  const theme = ctx.io.theme;
  const ip = await pickIpv4(theme, ips, 'should use these resolvers');
  if (!ip) return;
  const choice = await select<string>(
    {
      message: `DNS resolvers for ${ip.address}${ip.nameservers ? ` (now ${ip.nameservers})` : ''}`,
      label: 'Resolvers',
      options: [
        ...RESOLVER_PRESETS,
        { label: 'Custom…', value: '__custom', hint: 'up to 3 IP addresses' },
        {
          label: 'Reset to default',
          value: '__reset',
          hint: 'use BitQate resolvers',
        },
      ],
    },
    theme,
  );
  let nameservers: string | null;
  if (choice === '__reset') nameservers = null;
  else if (choice === '__custom') {
    const raw = await text(
      {
        message: 'Resolver IPs (space or comma separated)',
        label: 'Resolvers',
        validate: (v) =>
          parseResolvers(v) ? null : 'Enter 1 to 3 IP addresses',
      },
      theme,
    );
    nameservers = parseResolvers(raw);
  } else nameservers = choice;
  await task('Saving DNS resolvers', theme, () =>
    ctx
      .api()
      .put(['vms', id, 'networking', 'dns'], {
        address: ip.address,
        nameservers,
      }),
  );
  say(
    check(
      theme,
      nameservers
        ? `Saved resolvers ${nameservers} for ${ip.address}`
        : `Reset resolvers for ${ip.address}`,
    ),
  );
  say(
    theme.paint(
      'muted',
      '  To use them right away, set them in /etc/resolv.conf on the VM.',
    ),
  );
}

async function loadHosts(ctx: RunContext, id: string, block: string) {
  const resp = await ctx
    .api()
    .get(['vms', id, 'networking', 'ipv6', 'addresses'], { block, limit: 100 });
  return {
    addresses: (resp?.addresses ?? []) as {
      address: string;
      rdns: string | null;
    }[],
    total: Number(resp?.total ?? 0),
    max: Number(resp?.max ?? 0),
  };
}

async function interactiveIpv6(ctx: RunContext, id: string, ips: IpRow[]) {
  const theme = ctx.io.theme;
  const blocks = ips.filter((i) => i.version === 6);
  if (!blocks.length) {
    say(theme.paint('muted', '  This VM has no IPv6 block.'));
    return;
  }
  let blockAddr = blocks[0].address;
  if (blocks.length > 1)
    blockAddr = await select<string>(
      {
        message: 'Which IPv6 block?',
        label: 'Block',
        options: blocks.map((b) => ({
          label: `${b.address}/${b.cidr ?? '64'}`,
          value: b.address,
        })),
      },
      theme,
    );

  for (;;) {
    const hosts = await task('Loading IPv6 addresses', theme, () =>
      loadHosts(ctx, id, blockAddr),
    );
    say('');
    say(
      `${theme.paint('strong', `IPv6 ${blockAddr}`)} ${theme.paint('muted', `${hosts.total}${hosts.max ? ` of ${hosts.max}` : ''} host addresses`)}`,
    );
    for (const h of hosts.addresses)
      say(
        `  ${sanitize(h.address)}  ${h.rdns ? sanitize(h.rdns) : theme.paint('muted', '-')}`,
      );
    say('');
    const action = await select<string>(
      {
        message: 'IPv6',
        options: [
          {
            label: 'Add an address',
            value: 'add',
            hint: 'picks a random free one in the block',
          },
          ...(hosts.addresses.length
            ? [
                { label: 'Set rDNS for an address', value: 'rdns' },
                { label: 'Remove addresses', value: 'remove' },
              ]
            : []),
          { label: 'Back', value: 'back' },
        ],
      },
      theme,
    );
    if (action === 'back') return;
    if (action === 'add') {
      const resp = await task('Adding an IPv6 address', theme, () =>
        ctx
          .api()
          .post(['vms', id, 'networking', 'ipv6', 'addresses'], {
            block: blockAddr,
          }),
      );
      const addr = resp?.address?.address;
      say(check(theme, `Added ${sanitize(String(addr ?? 'an address'))}`));
      say(
        theme.paint(
          'muted',
          "  Configure it on the VM's network interface to start using it.",
        ),
      );
      continue;
    }
    if (action === 'rdns') {
      const address = await select<string>(
        {
          message: 'Which address?',
          label: 'Address',
          options: hosts.addresses.map((h) => ({
            label: h.address,
            value: h.address,
            hint: h.rdns ?? '',
          })),
        },
        theme,
      );
      const current =
        hosts.addresses.find((h) => h.address === address)?.rdns ?? '';
      say(
        theme.paint(
          'muted',
          `  Add an AAAA record for the hostname pointing to ${address} first.`,
        ),
      );
      const value = await text(
        {
          message: current
            ? `Hostname (now ${current}, blank to clear)`
            : 'Hostname',
          label: 'rDNS',
          blankLabel: current ? 'clear' : 'unchanged',
          validate: (v) => (!v.trim() ? null : validHostname(v)),
        },
        theme,
      );
      const hostname = value.trim().replace(/\.$/, '') || null;
      if ((!hostname && !current) || hostname === current) continue;
      const resp = await putRdns(ctx, id, address, hostname, true);
      for (const l of rdnsDone(theme, address, hostname, resp?.dnsSynced))
        say(l);
      continue;
    }
    if (action === 'remove') {
      const address = await select<string>(
        {
          message: 'Remove which address?',
          label: 'Remove',
          options: hosts.addresses.map((h) => ({
            label: h.address,
            value: h.address,
            hint: h.rdns ?? '',
          })),
        },
        theme,
      );
      const sure = await confirm(
        {
          message: `Remove ${address}? Anything using it on the VM stops working.`,
          label: 'Remove',
          default: false,
        },
        theme,
      );
      if (!sure) continue;
      await task('Removing', theme, () =>
        ctx
          .api()
          .post(['vms', id, 'networking', 'ipv6', 'addresses', 'remove'], {
            addresses: [address],
          }),
      );
      say(check(theme, `Removed ${address}`));
    }
  }
}

async function networkManager(ctx: RunContext) {
  const theme = ctx.io.theme;
  const { id, name } = await resolveVm(ctx);
  for (;;) {
    const ips = await task('Loading network', theme, () => loadIps(ctx, id));
    say('');
    say(theme.paint('strong', `Network · ${sanitize(name)}`));
    say('');
    for (const l of ipTable(theme, ips)) say(l);
    say('');
    const hasV4 = ips.some((i) => i.version === 4);
    const hasV6 = ips.some((i) => i.version === 6);
    const action = await select<string>(
      {
        message: 'What do you want to change?',
        options: [
          ...(hasV4
            ? [
                {
                  label: 'Reverse DNS (rDNS)',
                  value: 'rdns',
                  hint: 'hostname for an IPv4 address',
                },
                {
                  label: 'DNS resolvers',
                  value: 'dns',
                  hint: 'Cloudflare, Google, Quad9 or custom',
                },
              ]
            : []),
          ...(hasV6
            ? [
                {
                  label: 'IPv6 addresses',
                  value: 'ipv6',
                  hint: 'add, set rDNS, remove',
                },
              ]
            : []),
          {
            label: 'Buy another IP or change networking in the dashboard',
            value: 'open',
          },
          { label: 'Done', value: 'done' },
        ],
      },
      theme,
    );
    try {
      if (action === 'done') break;
      if (action === 'rdns') await interactiveRdns(ctx, id, ips);
      else if (action === 'dns') await interactiveResolvers(ctx, id, ips);
      else if (action === 'ipv6') await interactiveIpv6(ctx, id, ips);
      else if (action === 'open') {
        await openUrl(`${portalUrl('vm', id)}`);
        break;
      }
    } catch (err) {
      if (
        err instanceof CliError &&
        err.code !== 'cancelled' &&
        err.code !== 'unauthenticated'
      ) {
        say(
          `${theme.paint('danger', theme.glyph('cross'))} ${sanitize(err.message)}`,
        );
        continue;
      }
      throw err;
    }
  }
  return { data: { id }, render: () => ({ lines: [] as string[] }) };
}

const showNetwork = async (ctx: RunContext) => {
  if (ctx.io.interactive && !ctx.io.json && !ctx.io.quiet)
    return networkManager(ctx);
  const { id } = await resolveVm(ctx);
  const ips = await loadIps(ctx, id);
  return {
    data: ips,
    render: (rows: IpRow[], ui: RunContext['io']) => ({
      lines: ipTable(ui.theme, rows),
    }),
  };
};

for (const sub of ['network', 'networking'])
  register({
    path: ['vms', sub],
    summary:
      sub === 'network'
        ? 'Manage IPs, reverse DNS, DNS resolvers and IPv6'
        : 'Show network addresses (same as vms network)',
    description:
      'On a terminal this opens an interactive menu. Elsewhere it prints the addresses.',
    args: [{ name: 'id', required: false, description: 'VM name or ID' }],
    flags: {},
    scope: 'vms:read',
    examples: [
      `bitqate vms ${sub} dizzy-puma`,
      `bitqate vms ${sub} dizzy-puma --json`,
    ],
    run: showNetwork,
  });

async function addressFor(
  ctx: RunContext,
  id: string,
  version: 4 | 6,
): Promise<string> {
  if (ctx.flags.address) return String(ctx.flags.address);
  if (!ctx.io.interactive || ctx.io.json)
    throw usageError('Pass --address <ip>');
  const ips = await loadIps(ctx, id);
  if (version === 4) {
    const ip = await pickIpv4(ctx.io.theme, ips, 'do you want to change');
    if (!ip) throw usageError('This VM has no IPv4 address');
    return ip.address;
  }
  throw usageError('Pass --address <ip>');
}

register({
  path: ['vms', 'rdns'],
  summary: 'Set reverse DNS for an IP',
  description:
    'Point an A (or AAAA) record for the hostname at the IP first; BitQate checks it before saving.',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    address: {
      type: 'string',
      placeholder: 'ip',
      description: 'IP address (asked when omitted)',
    },
    hostname: {
      type: 'string',
      placeholder: 'host',
      description: 'rDNS hostname (asked when omitted)',
    },
    clear: { type: 'boolean', description: 'Remove the rDNS record' },
  },
  scope: 'vms:write',
  examples: [
    'bitqate vms rdns dizzy-puma',
    'bitqate vms rdns dizzy-puma --address 203.0.113.10 --hostname mail.example.com',
    'bitqate vms rdns dizzy-puma --address 203.0.113.10 --clear',
  ],
  async run(ctx) {
    const { id, name } = await resolveVm(ctx);
    if (ctx.flags.clear && ctx.flags.hostname)
      throw usageError('Pass --hostname or --clear, not both');
    const address = await addressFor(ctx, id, 4);
    if (!isIP(address)) throw usageError(`'${address}' is not an IP address`);
    let hostname: string | null = ctx.flags.clear
      ? null
      : (ctx.flags.hostname ?? null);
    if (!ctx.flags.clear && !hostname) {
      if (!ctx.io.interactive || ctx.io.json)
        throw usageError('Pass --hostname <host> or --clear');
      hostname = (
        await text(
          { message: 'Hostname', label: 'rDNS', validate: validHostname },
          ctx.io.theme,
        )
      ).trim();
    }
    if (hostname && validHostname(hostname))
      throw usageError(`'${hostname}' is not a valid hostname`);
    const resp = await putRdns(ctx, id, address, hostname, isIP(address) === 6);
    return {
      data: {
        id,
        address,
        rdns: resp?.rdns ?? hostname,
        dnsSynced: resp?.dnsSynced,
      },
      render: (d, ui) => ({
        lines: rdnsDone(ui.theme, address, d.rdns, d.dnsSynced),
      }),
    };
  },
});

register({
  path: ['vms', 'dns'],
  summary: 'Set DNS resolvers for an IP',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    address: {
      type: 'string',
      placeholder: 'ip',
      description: 'IPv4 address (asked when omitted)',
    },
    servers: {
      type: 'string',
      placeholder: 'ips',
      description: 'Up to 3 resolver IPs, or cloudflare, google or quad9',
    },
    reset: { type: 'boolean', description: 'Go back to the default resolvers' },
  },
  scope: 'vms:write',
  examples: [
    'bitqate vms dns dizzy-puma --servers cloudflare',
    'bitqate vms dns dizzy-puma --address 203.0.113.10 --servers "1.1.1.1 9.9.9.9"',
    'bitqate vms dns dizzy-puma --reset',
  ],
  async run(ctx) {
    const { id } = await resolveVm(ctx);
    if (!ctx.flags.servers && !ctx.flags.reset) {
      if (ctx.io.interactive && !ctx.io.json) {
        await interactiveResolvers(ctx, id, await loadIps(ctx, id));
        return { data: { id }, render: () => ({ lines: [] as string[] }) };
      }
      throw usageError('Pass --servers <ips> or --reset');
    }
    const address = await addressFor(ctx, id, 4);
    let nameservers: string | null = null;
    if (!ctx.flags.reset) {
      const raw = String(ctx.flags.servers);
      const preset = RESOLVER_PRESETS.find(
        (p) => p.label.toLowerCase() === raw.toLowerCase(),
      );
      nameservers = preset ? preset.value : parseResolvers(raw);
      if (!nameservers)
        throw usageError(
          'Pass 1 to 3 IP addresses, or cloudflare, google or quad9',
        );
    }
    const resp = await ctx
      .api()
      .put(['vms', id, 'networking', 'dns'], { address, nameservers });
    return {
      data: { id, address, nameservers: resp?.nameservers ?? nameservers },
      render: (d, ui) => ({
        lines: [
          check(
            ui.theme,
            d.nameservers
              ? `Saved resolvers ${d.nameservers} for ${address}`
              : `Reset resolvers for ${address}`,
          ),
          ui.theme.paint(
            'muted',
            '  To use them right away, set them in /etc/resolv.conf on the VM.',
          ),
        ],
      }),
    };
  },
});

function ipv6Block(ctx: RunContext): string | undefined {
  return ctx.flags.block ? String(ctx.flags.block) : undefined;
}

register({
  path: ['vms', 'ipv6', 'list'],
  summary: 'List IPv6 host addresses',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    block: {
      type: 'string',
      placeholder: 'prefix',
      description: 'IPv6 block (default: the first)',
    },
  },
  scope: 'vms:read',
  examples: ['bitqate vms ipv6 list dizzy-puma'],
  async run(ctx) {
    const { id } = await resolveVm(ctx);
    const resp = await ctx
      .api()
      .get(['vms', id, 'networking', 'ipv6', 'addresses'], {
        block: ipv6Block(ctx),
        limit: 100,
      });
    const rows: { address: string; rdns: string | null }[] =
      resp?.addresses ?? [];
    return {
      data: resp,
      render: () => ({
        table: {
          columns: [{ title: 'Address' }, { title: 'rDNS', priority: 2 }],
          rows: rows.map((r) => [r.address, r.rdns ?? '']),
        },
      }),
    };
  },
});

register({
  path: ['vms', 'ipv6', 'add'],
  summary: 'Add an IPv6 host address',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    block: {
      type: 'string',
      placeholder: 'prefix',
      description: 'IPv6 block (default: the first)',
    },
  },
  scope: 'vms:write',
  examples: ['bitqate vms ipv6 add dizzy-puma'],
  async run(ctx) {
    const { id } = await resolveVm(ctx);
    const block = ipv6Block(ctx);
    const resp = await ctx
      .api()
      .post(
        ['vms', id, 'networking', 'ipv6', 'addresses'],
        block ? { block } : {},
      );
    return {
      data: resp?.address ?? resp,
      render: (d, ui) => ({
        lines: [check(ui.theme, `Added ${sanitize(String(d?.address ?? ''))}`)],
      }),
    };
  },
});

register({
  path: ['vms', 'ipv6', 'rdns'],
  summary: 'Set reverse DNS for an IPv6 host address',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    address: {
      type: 'string',
      placeholder: 'ip',
      required: true,
      description: 'IPv6 host address',
    },
    hostname: {
      type: 'string',
      placeholder: 'host',
      description: 'rDNS hostname',
    },
    clear: { type: 'boolean', description: 'Remove the rDNS record' },
  },
  scope: 'vms:write',
  examples: [
    'bitqate vms ipv6 rdns dizzy-puma --address 2001:db8::10 --hostname mail.example.com',
  ],
  async run(ctx) {
    const { id } = await resolveVm(ctx);
    const address = String(ctx.flags.address);
    if (isIP(address) !== 6)
      throw usageError(`'${address}' is not an IPv6 address`);
    if (!ctx.flags.clear && !ctx.flags.hostname)
      throw usageError('Pass --hostname <host> or --clear');
    const hostname = ctx.flags.clear ? null : String(ctx.flags.hostname);
    if (hostname && validHostname(hostname))
      throw usageError(`'${hostname}' is not a valid hostname`);
    const resp = await putRdns(ctx, id, address, hostname, true);
    return {
      data: {
        id,
        address,
        rdns: resp?.rdns ?? hostname,
        dnsSynced: resp?.dnsSynced,
      },
      render: (d, ui) => ({
        lines: rdnsDone(ui.theme, address, d.rdns, d.dnsSynced),
      }),
    };
  },
});

register({
  path: ['vms', 'ipv6', 'remove'],
  summary: 'Remove IPv6 host addresses',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    address: {
      type: 'string',
      placeholder: 'ip',
      multiple: true,
      required: true,
      description: 'IPv6 host address (repeatable)',
    },
  },
  scope: 'vms:write',
  destructive: true,
  confirmInside: true,
  examples: ['bitqate vms ipv6 remove dizzy-puma --address 2001:db8::10 --yes'],
  async run(ctx) {
    const { id } = await resolveVm(ctx);
    const addresses: string[] = ctx.flags.address ?? [];
    for (const a of addresses)
      if (isIP(a) !== 6) throw usageError(`'${a}' is not an IPv6 address`);
    if (!ctx.io.yes && !ctx.flags['dry-run']) {
      if (!ctx.io.interactive || ctx.io.json)
        throw new CliError('usage', 'This action is destructive.', {
          hint: 'pass --yes to confirm',
        });
      const sure = await confirm(
        {
          message: `Remove ${addresses.join(', ')}?`,
          label: 'Remove',
          default: false,
        },
        ctx.io.theme,
      );
      if (!sure) throw new CliError('cancelled', 'Cancelled.');
    }
    const resp = await ctx
      .api()
      .post(['vms', id, 'networking', 'ipv6', 'addresses', 'remove'], {
        addresses,
      });
    return {
      data: { id, removed: resp?.removed ?? addresses.length },
      render: (d, ui) => ({
        lines: [
          check(
            ui.theme,
            `Removed ${d.removed} address${d.removed === 1 ? '' : 'es'}`,
          ),
        ],
      }),
    };
  },
});
