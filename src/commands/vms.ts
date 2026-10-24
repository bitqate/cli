import { readFileSync } from 'node:fs';
import { CliError, usageError } from '../core/errors';
import { kvLines } from '../core/output';
import { pollUntil } from '../core/poll';
import {
  cpusToUnits,
  positiveInt,
  validateSshPublicKey,
} from '../core/validate';
import { register, type RunContext } from '../registry';

const waitFlag = {
  wait: {
    type: 'boolean' as const,
    description: 'Wait until the operation finishes',
  },
  'wait-timeout': {
    type: 'string' as const,
    description: 'Seconds to wait before giving up (default 600)',
  },
};

function waitTimeoutMs(ctx: RunContext): number {
  const v = ctx.flags['wait-timeout'];
  return v ? positiveInt(String(v), 'wait-timeout') * 1000 : 600_000;
}

const VM_OK = new Set(['active', 'running']);
const VM_FAIL = new Set(['error', 'suspended']);

async function waitForVm(
  ctx: RunContext,
  id: string,
  targets: Set<string>,
  fail: Set<string>,
  label: string,
) {
  return pollUntil(
    async () => {
      const resp = await ctx.api().get(['vms', id]);
      const status = resp?.vm?.status;
      if (targets.has(status)) return resp.vm;
      if (fail.has(status))
        throw new CliError('server', `VM entered state '${status}'`);
      return null;
    },
    { timeoutMs: waitTimeoutMs(ctx), label },
  );
}

function vmTable(vms: any[]) {
  return {
    table: {
      head: ['ID', 'NAME', 'STATUS', 'IPV4', 'CPU', 'MEM MB', 'DISK GB'],
      rows: vms.map((v) => [
        v.id ?? '',
        v.name ?? '',
        v.status ?? '',
        v.ipv4 ?? '',
        String(v.resources?.cpu_cores ?? ''),
        String(v.resources?.memory_mb ?? ''),
        String(v.resources?.disk_gb ?? ''),
      ]),
    },
  };
}

register({
  path: ['vms', 'list'],
  summary: 'List your VMs',
  args: [],
  flags: {},
  scope: 'vms:read',
  examples: [
    'bitqate vms list',
    'bitqate vms list --json',
    'bitqate vms list -q',
  ],
  async run(ctx) {
    const resp = await ctx.api().get(['vms']);
    const data = resp?.vms ?? [];
    return { data, render: (rows: any[]) => vmTable(rows) };
  },
});

register({
  path: ['vms', 'get'],
  summary: 'Show one VM',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {},
  scope: 'vms:read',
  examples: ['bitqate vms get vm_abc123'],
  async run(ctx) {
    const resp = await ctx.api().get(['vms', ctx.args[0]]);
    const data = resp?.vm ?? {};
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['vms', 'nodes'],
  summary: 'List available VM host nodes',
  args: [],
  flags: {},
  scope: 'any',
  examples: ['bitqate vms nodes'],
  async run(ctx) {
    const resp = await ctx.api().get(['vm-nodes']);
    const data = resp?.nodes ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          head: ['ID', 'NAME', 'NICKNAME'],
          rows: rows.map((n) => [n.id ?? '', n.name ?? '', n.nickname ?? '']),
        },
      }),
    };
  },
});

register({
  path: ['vms', 'os'],
  summary: 'List operating system templates',
  args: [],
  flags: {
    node: { type: 'string', description: 'Only show templates on this node' },
  },
  scope: 'any',
  examples: ['bitqate vms os', 'bitqate vms os --node pve-fra-1'],
  async run(ctx) {
    const resp = await ctx.api().get(['operating-systems']);
    let data: any[] = resp?.operating_systems ?? [];
    if (ctx.flags.node)
      data = data.filter((o) => (o.node_ids ?? []).includes(ctx.flags.node));
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          head: ['ID', 'NAME', 'NODES'],
          rows: rows.map((o) => [
            o.id ?? '',
            o.name ?? '',
            (o.node_ids ?? []).join(','),
          ]),
        },
      }),
    };
  },
});

register({
  path: ['vms', 'create'],
  summary: 'Create a VM (charges your balance)',
  args: [],
  flags: {
    node: { type: 'string', required: true, description: 'PVE node ID' },
    os: { type: 'string', required: true, description: 'Operating system ID' },
    'memory-mb': {
      type: 'string',
      required: true,
      description: 'Memory in MB',
    },
    cpus: { type: 'string', required: true, description: 'CPU cores' },
    'disk-gb': { type: 'string', required: true, description: 'Disk in GB' },
    name: { type: 'string', description: 'VM name' },
    'ssh-key-file': {
      type: 'string',
      description: 'Path to a .pub OpenSSH public key',
    },
    workspace: { type: 'string', description: 'Workspace (team) ID' },
    'auto-renew': { type: 'boolean', description: 'Enable auto-renewal' },
    ...waitFlag,
  },
  scope: 'vms:write',
  examples: [
    'bitqate vms create --node pve-fra-1 --os debian-12 --memory-mb 4096 --cpus 2 --disk-gb 40 --name web-1 --ssh-key-file ~/.ssh/id_ed25519.pub --wait',
  ],
  async run(ctx) {
    const body: Record<string, unknown> = {
      pve_node_id: ctx.flags.node,
      operating_system_id: ctx.flags.os,
      memory: positiveInt(ctx.flags['memory-mb'], 'memory-mb'),
      cpu: Number(ctx.flags.cpus),
      drive: positiveInt(ctx.flags['disk-gb'], 'disk-gb'),
    };
    if (!Number.isFinite(body.cpu) || (body.cpu as number) <= 0)
      throw usageError('--cpus must be a positive number');
    if (ctx.flags.name) body.name = ctx.flags.name;
    if (ctx.flags.workspace) body.team_id = ctx.flags.workspace;
    if (ctx.flags['auto-renew']) body.auto_renew = true;
    if (ctx.flags['ssh-key-file']) {
      let content: string;
      try {
        content = readFileSync(ctx.flags['ssh-key-file'], 'utf8');
      } catch {
        throw usageError(`Cannot read ${ctx.flags['ssh-key-file']}`);
      }
      body.ssh_public_key = validateSshPublicKey(content);
    }
    const resp = await ctx.api().post(['vms'], body);
    const vm = resp?.vm ?? {};
    if (ctx.flags.wait && vm.id) {
      const final = await waitForVm(
        ctx,
        vm.id,
        VM_OK,
        new Set([...VM_FAIL]),
        'VM provisioning',
      );
      return { data: final, render: (d) => ({ lines: kvLines(d) }) };
    }
    return { data: vm, render: (d) => ({ lines: kvLines(d) }) };
  },
});

for (const op of ['start', 'stop', 'restart'] as const) {
  register({
    path: ['vms', op],
    summary: `${op[0].toUpperCase() + op.slice(1)} a VM`,
    args: [{ name: 'id', required: true, description: 'VM ID' }],
    flags: { ...waitFlag },
    scope: 'vms:power',
    destructive: false,
    examples: [
      `bitqate vms ${op} vm_abc123`,
      `bitqate vms ${op} vm_abc123 --wait`,
    ],
    async run(ctx) {
      const resp = await ctx.api().post(['vms', ctx.args[0], op]);
      if (!ctx.flags.wait) {
        return {
          data: { id: ctx.args[0], message: resp?.message ?? '' },
          render: (d) => ({ lines: [d.message] }),
        };
      }
      const targets =
        op === 'stop' ? new Set(['stopped']) : new Set(['running', 'active']);
      const final = await waitForVm(
        ctx,
        ctx.args[0],
        targets,
        VM_FAIL,
        `VM ${op}`,
      );
      return { data: final, render: (d) => ({ lines: kvLines(d) }) };
    },
  });
}

register({
  path: ['vms', 'resize'],
  summary: 'Resize a VM (charges your balance)',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {
    'memory-mb': { type: 'string', description: 'Memory in MB' },
    cpus: { type: 'string', description: 'CPU cores' },
    'disk-gb': { type: 'string', description: 'Disk in GB' },
  },
  scope: 'vms:write',
  examples: ['bitqate vms resize vm_abc123 --memory-mb 8192 --cpus 4'],
  async run(ctx) {
    const body: Record<string, unknown> = {};
    if (ctx.flags['memory-mb'] !== undefined)
      body.memory = positiveInt(ctx.flags['memory-mb'], 'memory-mb');
    if (ctx.flags.cpus !== undefined) {
      const cpu = Number(ctx.flags.cpus);
      if (!Number.isFinite(cpu) || cpu <= 0)
        throw usageError('--cpus must be a positive number');
      body.cpu = cpu;
    }
    if (ctx.flags['disk-gb'] !== undefined)
      body.drive = positiveInt(ctx.flags['disk-gb'], 'disk-gb');
    if (!Object.keys(body).length)
      throw usageError('Pass at least one of --memory-mb, --cpus or --disk-gb');
    const resp = await ctx.api().patch(['vms', ctx.args[0], 'resize'], body);
    const data = {
      ...(resp?.vm ?? {}),
      charged: resp?.charged,
      newMonthlyCost: resp?.newMonthlyCost,
    };
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['vms', 'rename'],
  summary: 'Rename a VM',
  args: [
    { name: 'id', required: true, description: 'VM ID' },
    { name: 'name', required: true, description: 'New name' },
  ],
  flags: {},
  scope: 'vms:write',
  examples: ['bitqate vms rename vm_abc123 web-2'],
  async run(ctx) {
    const resp = await ctx.api().patch(['vms', ctx.args[0], 'name'], {
      name: ctx.args[1],
    });
    const data = resp?.vm ?? { id: ctx.args[0], name: ctx.args[1] };
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['vms', 'auto-renew'],
  summary: 'Enable or disable VM auto-renewal',
  args: [
    { name: 'id', required: true, description: 'VM ID' },
    { name: 'state', required: true, description: 'on or off' },
  ],
  flags: {},
  scope: 'vms:write',
  examples: ['bitqate vms auto-renew vm_abc123 on'],
  async run(ctx) {
    const state = ctx.args[1];
    if (state !== 'on' && state !== 'off')
      throw usageError("Expected 'on' or 'off'");
    const resp = await ctx.api().patch(['vms', ctx.args[0], 'auto-renew'], {
      auto_renew: state === 'on',
    });
    return {
      data: {
        id: ctx.args[0],
        auto_renew: state === 'on',
        message: resp?.message,
      },
      render: (d) => ({ lines: [d.message ?? ''] }),
    };
  },
});

register({
  path: ['vms', 'renew'],
  summary: 'Renew a VM for 30 days (charges your balance)',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {},
  scope: 'vms:write',
  examples: ['bitqate vms renew vm_abc123'],
  async run(ctx) {
    const resp = await ctx.api().post(['vms', ctx.args[0], 'renew']);
    const data = {
      id: ctx.args[0],
      message: resp?.message,
      expires_at: resp?.expires_at,
    };
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['vms', 'reinstall'],
  summary: 'Reinstall a VM from a fresh OS template (destroys its disk)',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {
    os: { type: 'string', required: true, description: 'Operating system ID' },
  },
  scope: 'vms:delete',
  destructive: true,
  examples: ['bitqate vms reinstall vm_abc123 --os debian-12'],
  async run(ctx) {
    const resp = await ctx.api().post(['vms', ctx.args[0], 'reinstall'], {
      operating_system_id: ctx.flags.os,
    });
    const data = { ...(resp?.vm ?? {}), message: resp?.message };
    return { data, render: (d) => ({ lines: [d.message ?? ''] }) };
  },
});

register({
  path: ['vms', 'delete'],
  summary: 'Delete a VM permanently',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {},
  scope: 'vms:delete',
  destructive: true,
  examples: ['bitqate vms delete vm_abc123 --yes'],
  async run(ctx) {
    const resp = await ctx.api().delete(['vms', ctx.args[0]]);
    const data = {
      id: ctx.args[0],
      refunded: resp?.refunded,
      message: resp?.message,
    };
    return { data, render: (d) => ({ lines: [d.message ?? ''] }) };
  },
});

register({
  path: ['vms', 'backups', 'list'],
  summary: 'List backups of a VM',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {},
  scope: 'vms:read',
  examples: ['bitqate vms backups list vm_abc123'],
  async run(ctx) {
    const resp = await ctx.api().get(['vms', ctx.args[0], 'backups']);
    const data = resp?.backups ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          head: ['TOKEN', 'NAME', 'SIZE', 'CREATED'],
          rows: rows.map((b) => [
            b.token ?? b.volid ?? '',
            b.name ?? '',
            b.size != null ? String(b.size) : '',
            b.created_at ?? b.ctime ?? '',
          ]),
        },
      }),
    };
  },
});

register({
  path: ['vms', 'backups', 'create'],
  summary: 'Create a VM backup',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {},
  scope: 'vms:write',
  examples: ['bitqate vms backups create vm_abc123'],
  async run(ctx) {
    const resp = await ctx.api().post(['vms', ctx.args[0], 'backups']);
    return {
      data: { id: ctx.args[0], message: resp?.message ?? '' },
      render: (d) => ({ lines: [d.message] }),
    };
  },
});

register({
  path: ['vms', 'backups', 'restore'],
  summary: 'Restore a VM backup (overwrites the VM disk)',
  args: [
    { name: 'id', required: true, description: 'VM ID' },
    { name: 'token', required: true, description: 'Backup token' },
  ],
  flags: {},
  scope: 'vms:delete',
  destructive: true,
  examples: ['bitqate vms backups restore vm_abc123 <token> --yes'],
  async run(ctx) {
    const resp = await ctx
      .api()
      .post(['vms', ctx.args[0], 'backups', ctx.args[1], 'restore']);
    return {
      data: { id: ctx.args[0], message: resp?.message ?? '' },
      render: (d) => ({ lines: [d.message] }),
    };
  },
});

register({
  path: ['vms', 'backups', 'delete'],
  summary: 'Delete a VM backup permanently',
  args: [
    { name: 'id', required: true, description: 'VM ID' },
    { name: 'token', required: true, description: 'Backup token' },
  ],
  flags: {},
  scope: 'vms:delete',
  destructive: true,
  examples: ['bitqate vms backups delete vm_abc123 <token> --yes'],
  async run(ctx) {
    const resp = await ctx
      .api()
      .delete(['vms', ctx.args[0], 'backups', ctx.args[1]]);
    return {
      data: { id: ctx.args[0], message: resp?.message ?? '' },
      render: (d) => ({ lines: [d.message] }),
    };
  },
});

register({
  path: ['vms', 'networking'],
  summary: 'Show VM network addresses',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {},
  scope: 'vms:read',
  examples: ['bitqate vms networking vm_abc123'],
  async run(ctx) {
    const resp = await ctx.api().get(['vms', ctx.args[0], 'networking']);
    const data = resp?.ips ?? resp;
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          head: ['ADDRESS', 'VERSION', 'CIDR', 'RDNS'],
          rows: (Array.isArray(rows) ? rows : []).map((ip) => [
            ip.address ?? ip.ip_address ?? '',
            String(ip.version ?? ''),
            String(ip.cidr ?? ''),
            ip.rdns ?? '',
          ]),
        },
      }),
    };
  },
});

register({
  path: ['vms', 'rdns'],
  summary: 'Set the reverse DNS hostname for a VM address',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {
    address: { type: 'string', required: true, description: 'IP address' },
    hostname: { type: 'string', required: true, description: 'rDNS hostname' },
  },
  scope: 'vms:write',
  examples: [
    'bitqate vms rdns vm_abc123 --address 203.0.113.10 --hostname mail.example.com',
  ],
  async run(ctx) {
    const resp = await ctx
      .api()
      .put(['vms', ctx.args[0], 'networking', 'rdns'], {
        address: ctx.flags.address,
        rdns: ctx.flags.hostname,
      });
    const data = {
      id: ctx.args[0],
      rdns: resp?.rdns,
      dnsSynced: resp?.dnsSynced,
    };
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['vms', 'stats'],
  summary: 'Show VM usage statistics',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {
    range: {
      type: 'string',
      description: 'hour, day, week, month or year (default hour)',
    },
    cf: { type: 'string', description: 'AVERAGE or MAX (default AVERAGE)' },
  },
  scope: 'vms:read',
  examples: ['bitqate vms stats vm_abc123 --range day'],
  async run(ctx) {
    const resp = await ctx.api().get(['vms', ctx.args[0], 'stats'], {
      range: ctx.flags.range,
      cf: ctx.flags.cf,
    });
    const data = resp?.stats ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          head: ['TIME', 'CPU %', 'MEM %', 'DISK %'],
          rows: rows.map((s) => [
            s.time ? new Date(s.time).toISOString() : '',
            String(s.cpu ?? ''),
            String(s.mem ?? ''),
            String(s.disk ?? ''),
          ]),
        },
      }),
    };
  },
});

register({
  path: ['vms', 'wait'],
  summary: 'Wait for a VM to reach a status',
  args: [{ name: 'id', required: true, description: 'VM ID' }],
  flags: {
    status: { type: 'string', required: true, description: 'Target status' },
    'wait-timeout': waitFlag['wait-timeout'],
  },
  scope: 'vms:read',
  examples: ['bitqate vms wait vm_abc123 --status running'],
  async run(ctx) {
    const target = ctx.flags.status;
    const fail = new Set([...VM_FAIL].filter((s) => s !== target));
    const vm = await waitForVm(
      ctx,
      ctx.args[0],
      new Set([target]),
      fail,
      `status ${target}`,
    );
    return { data: vm, render: (d) => ({ lines: kvLines(d) }) };
  },
});
