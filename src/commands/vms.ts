import { readFileSync } from 'node:fs';
import { CliError, usageError } from '../core/errors';
import { confirmDestroy, waitPoll } from '../core/confirm';
import { portalUrl, openUrl } from '../core/portal';
import { resolveOption, resolveResource } from '../core/resolve';
import { detailToLines, sanitize } from '../core/output';
import { task } from '../ui/spinner';
import {
  elapsedLong,
  memory,
  moneyMo,
  relTime,
  shortId,
  sizeLine,
} from '../ui/format';
import { statusText } from '../ui/theme';
import { positiveInt, validateSshPublicKey } from '../core/validate';
import { register, type CommandResult, type RunContext } from '../registry';
import { vmWizard } from '../wizards/vm';
import { sshInto, vmBusy } from './tools';

const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

const VM_OK = new Set(['active', 'running']);
const VM_FAIL = new Set(['error', 'suspended']);

function ok(data: any, msg: string): CommandResult {
  return { data, render: () => ({ lines: [msg] }) };
}

function checkmark(ui: { theme: any }, msg: string): string {
  return `${ui.theme.paint('success', ui.theme.glyph('check'))} ${msg}`;
}

function waitTimeoutMs(ctx: RunContext): number {
  const v = ctx.flags['wait-timeout'];
  return v ? positiveInt(String(v), 'wait-timeout') * 1000 : 600_000;
}

async function resolveVm(ctx: RunContext, ref?: string) {
  return resolveResource(ctx, 'vms', ref ?? ctx.args[0], ctx.io.theme);
}

async function fetchVm(ctx: RunContext, id: string) {
  const resp = await ctx.api().get(['vms', id]);
  return resp?.vm;
}

async function waitForVm(
  ctx: RunContext,
  resolved: { id: string; name: string },
  targets: Set<string>,
  fail: Set<string>,
  label: string,
) {
  return task(
    `${label} ${resolved.name}`,
    ctx.io.theme,
    async (t) =>
      waitPoll(
        { name: resolved.name, kind: 'vms' },
        async () => {
          const vm = await fetchVm(ctx, resolved.id);
          const status = vm?.status ?? 'unknown';
          t.update(status);
          if (targets.has(status)) return { value: vm, status };
          if (fail.has(status))
            throw new CliError('server', `VM entered state '${status}'`);
          return { value: null, status };
        },
        { timeoutMs: waitTimeoutMs(ctx), label },
      ),
    { endStyle: 'ok' },
  );
}

function vmRow(v: any, tty: boolean) {
  return [
    v.name ?? '',
    tty ? shortId(v.id ?? '') : (v.id ?? ''),
    '',
    v.status ?? '',
    sizeLine(
      v.resources?.cpu_cores ?? 0,
      v.resources?.memory_mb ?? 0,
      v.resources?.disk_gb ?? 0,
    ),
    v.ipv4 ?? '',
    relTime(v.created_at),
  ];
}

register({
  path: ['vms', 'list'],
  summary: 'List your VMs',
  args: [],
  flags: {},
  scope: 'vms:read',
  aliases: ['ls'],
  examples: [
    'bitqate vms list',
    'bitqate vms ls --json',
    'bitqate vms list -q',
  ],
  async run(ctx) {
    const resp = await ctx.api().get(['vms']);
    const data = resp?.vms ?? [];
    return {
      data,
      render: (rows: any[], ui) => {
        if (!rows.length)
          return {
            lines: ['No VMs yet. Create one with `bitqate vms create`.'],
          };
        const running = rows.filter((v) =>
          ['running', 'active'].includes(v.status),
        ).length;
        const tty = !!process.stdout.isTTY;
        const tableRows = rows.map((v) => {
          const r = vmRow(v, tty);
          r[2] = statusText(ui.theme, v.status ?? '');
          return r;
        });
        return {
          table: {
            columns: [
              { title: 'Name', truncate: true },
              { title: 'ID', priority: 1 },
              { title: 'Status', priority: 8 },
              { title: 'Size', priority: 4 },
              { title: 'IPv4', priority: 6 },
              { title: 'Created', priority: 2 },
            ],
            rows: tableRows.map((r) => [r[0], r[1], r[2], r[4], r[5], r[6]]),
            footer: `${rows.length} VM${rows.length === 1 ? '' : 's'} · ${running} running`,
          },
        };
      },
    };
  },
});

register({
  path: ['vms', 'get'],
  summary: 'Show one VM',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {},
  scope: 'vms:read',
  aliases: ['show', 'info'],
  examples: ['bitqate vms get dizzy-puma'],
  async run(ctx) {
    const { id } = await resolveVm(ctx);
    const vm = await fetchVm(ctx, id);
    if (!vm) throw new CliError('not_found', `VM '${id}' not found`);
    const data = vm;
    return {
      data,
      render: (v: any, ui) => {
        const hints: [string, string][] = [];
        if (!vmBusy(v.status))
          hints.push([
            `bitqate vms ssh ${v.name ?? v.id}`,
            'connect over SSH',
          ]);
        hints.push([`bitqate open ${v.name ?? v.id}`, 'open in the dashboard']);
        return {
          detail: {
            title: `${v.name ?? ''}  ${statusText(ui.theme, v.status ?? '')}`,
            id: v.id,
            fields: [
              ['Region', v.region?.name ?? v.pve_node_id],
              ['OS', v.os_name ?? v.operating_system_id],
              [
                'Size',
                `${v.resources?.cpu_cores ?? 0} vCPU · ${memory(v.resources?.memory_mb ?? 0)} RAM · ${v.resources?.disk_gb ?? 0} GB disk`,
              ],
              ['IPv4', v.ipv4],
              ['IPv6', v.ipv6],
              ['Host key', v.ssh?.host_key_fingerprint],
              ['Created', relTime(v.created_at)],
              [
                'Renews',
                `${relTime(v.expires_at)} · auto-renew ${v.auto_renew ? 'on' : 'off'}`,
              ],
            ],
            hints,
          },
        };
      },
    };
  },
});

register({
  path: ['vms', 'nodes'],
  summary: 'List host nodes',
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
          columns: [{ title: 'ID' }, { title: 'Name' }, { title: 'Nickname' }],
          rows: rows.map((n) => [n.id ?? '', n.name ?? '', n.nickname ?? '']),
          footer: rows.length ? undefined : 'No nodes available.',
        },
      }),
    };
  },
});

register({
  path: ['vms', 'os'],
  summary: 'List OS templates',
  args: [],
  flags: {
    node: {
      type: 'string',
      placeholder: 'node',
      description: 'Only show templates on this node',
    },
  },
  scope: 'any',
  examples: ['bitqate vms os', 'bitqate vms os --node montreal'],
  async run(ctx) {
    const resp = await ctx.api().get(['operating-systems']);
    let data: any[] = resp?.operating_systems ?? [];
    if (ctx.flags.node)
      data = data.filter((o) => (o.node_ids ?? []).includes(ctx.flags.node));
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          columns: [{ title: 'ID' }, { title: 'Name' }, { title: 'Nodes' }],
          rows: rows.map((o) => [
            o.id ?? '',
            o.name ?? '',
            (o.node_ids ?? []).join(','),
          ]),
          footer: rows.length ? undefined : 'No OS templates on this node.',
        },
      }),
    };
  },
});

register({
  path: ['vms', 'create'],
  summary: 'Create a VM',
  args: [],
  flags: {
    node: {
      type: 'string',
      placeholder: 'node',
      description: 'Node name, nickname or ID',
    },
    os: {
      type: 'string',
      placeholder: 'os',
      description: 'Operating system name or ID',
    },
    'memory-mb': {
      type: 'string',
      placeholder: 'mb',
      description: 'Memory in MB',
    },
    cpus: { type: 'string', placeholder: 'n', description: 'CPU cores' },
    'disk-gb': { type: 'string', placeholder: 'gb', description: 'Disk in GB' },
    name: { type: 'string', placeholder: 'name', description: 'VM name' },
    'ssh-key-file': {
      type: 'string',
      placeholder: 'path',
      description: 'Path to a .pub OpenSSH key',
    },
    workspace: {
      type: 'string',
      placeholder: 'workspace',
      description: 'Workspace name or ID',
    },
    'auto-renew': { type: 'boolean', description: 'Enable auto-renewal' },
    'ipv6-only': { type: 'boolean', description: 'No public IPv4 address' },
    wait: { type: 'boolean', description: 'Wait until it is ready' },
    'wait-timeout': {
      type: 'string',
      placeholder: 'seconds',
      description: 'Seconds before giving up',
    },
  },
  scope: 'vms:write',
  charges: true,
  interactive: true,
  aliases: ['new'],
  examples: [
    'bitqate vms create',
    'bitqate vms create --node montreal --os "debian 12" --memory-mb 4096 --cpus 2 --disk-gb 40',
  ],
  async run(ctx) {
    const missingRequired =
      !ctx.flags.node ||
      !ctx.flags.os ||
      !ctx.flags['memory-mb'] ||
      !ctx.flags.cpus ||
      !ctx.flags['disk-gb'];
    const useWizard = ctx.io.interactive && !ctx.io.json && missingRequired;

    let body: Record<string, unknown>;
    if (!useWizard) {
      const node = await resolveOption(
        ctx,
        ['vm-nodes'],
        ctx.flags.node,
        ['id', 'nickname', 'name'],
        'node',
      );
      const os = await resolveOption(
        ctx,
        ['operating-systems'],
        ctx.flags.os,
        ['id', 'name'],
        'OS',
        (o) => (o.node_ids ?? []).includes(node),
      );
      body = {
        pve_node_id: node,
        operating_system_id: os,
        memory: positiveInt(ctx.flags['memory-mb'], 'memory-mb'),
        cpu: Number(ctx.flags.cpus),
        drive: positiveInt(ctx.flags['disk-gb'], 'disk-gb'),
      };
      if (!Number.isFinite(body.cpu) || (body.cpu as number) <= 0)
        throw usageError('--cpus must be a positive number');
      if (ctx.flags.name) body.name = ctx.flags.name;
      if (ctx.flags.workspace)
        body.team_id = await resolveOption(
          ctx,
          ['workspaces'],
          ctx.flags.workspace,
          ['id', 'name'],
          'workspace',
        );
      if (ctx.flags['auto-renew']) body.auto_renew = true;
      if (ctx.flags['ipv6-only']) body.ipv4 = false;
      if (ctx.flags['ssh-key-file']) {
        let content: string;
        try {
          content = readFileSync(ctx.flags['ssh-key-file'], 'utf8');
        } catch {
          throw usageError(`Cannot read ${ctx.flags['ssh-key-file']}`);
        }
        body.ssh_public_key = validateSshPublicKey(content);
      }
    } else {
      body = (await vmWizard(ctx)).body;
    }

    const t0 = Date.now();
    const resp = await task('Creating VM', ctx.io.theme, () =>
      ctx.api().post(['vms'], body),
    );
    const vm = resp?.vm;
    if (!vm?.id) throw new CliError('server', 'Unexpected create response');
    const named = typeof body.name === 'string' && body.name ? body.name : null;
    const ref = named ?? shortId(vm.id);
    const label = named ?? `VM ${shortId(vm.id)}`;

    if (!ctx.flags.wait) {
      return {
        data: vm,
        render: (v, ui) => ({
          lines: [
            checkmark(
              ui,
              `${label} is now being created${vm.ip_address ? ` · ${vm.ip_address}` : ''}`,
            ),
            `  ${ui.theme.paint('muted', "You can't SSH in or manage it until it's done.")}`,
            `  ${ui.theme.paint('muted', `Check progress with bitqate vms get ${ref}`)}`,
          ],
        }),
      };
    }

    const ready = await waitForVm(
      ctx,
      { id: vm.id, name: ref },
      VM_OK,
      VM_FAIL,
      'Provisioning',
    );
    const final = ready?.name ?? ref;
    const secs = (Date.now() - t0) / 1000;
    return {
      data: ready,
      render: (v, ui) => ({
        lines: [
          checkmark(
            ui,
            `${final} is running (${elapsedLong(secs)})${ready?.ipv4 ? ` · ${ready.ipv4}` : ''}`,
          ),
          `  ${ui.theme.paint('muted', `bitqate vms ssh ${final}`)}`,
        ],
      }),
    };
  },
});

for (const op of ['start', 'stop', 'restart'] as const) {
  register({
    path: ['vms', op],
    summary: `${op[0].toUpperCase() + op.slice(1)} a VM`,
    args: [{ name: 'id', required: false, description: 'VM name or ID' }],
    flags: {
      wait: { type: 'boolean', description: 'Wait until it finishes' },
      'wait-timeout': {
        type: 'string',
        placeholder: 'seconds',
        description: 'Seconds before giving up',
      },
    },
    scope: 'vms:power',
    examples: [`bitqate vms ${op} dizzy-puma --wait`],
    async run(ctx) {
      const resolved = await resolveVm(ctx);
      await ctx.api().post(['vms', resolved.id, op]);
      if (!ctx.flags.wait) return ok({ id: resolved.id }, '');
      const targets =
        op === 'stop' ? new Set(['stopped']) : new Set(['running', 'active']);
      const vm = await waitForVm(
        ctx,
        resolved,
        targets,
        VM_FAIL,
        `${op[0].toUpperCase() + op.slice(1)}ing`,
      );
      return {
        data: vm,
        render: (v, ui) => ({
          lines: [
            checkmark(
              ui,
              `${op === 'stop' ? 'Stopped' : op === 'start' ? 'Started' : 'Restarted'} ${resolved.name}`,
            ),
          ],
        }),
      };
    },
  });
}

register({
  path: ['vms', 'resize'],
  summary: 'Change CPU, memory or disk',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    'memory-mb': {
      type: 'string',
      placeholder: 'mb',
      description: 'Memory in MB',
    },
    cpus: { type: 'string', placeholder: 'n', description: 'CPU cores' },
    'disk-gb': { type: 'string', placeholder: 'gb', description: 'Disk in GB' },
  },
  scope: 'vms:write',
  charges: true,
  examples: ['bitqate vms resize dizzy-puma --memory-mb 8192 --cpus 4'],
  async run(ctx) {
    const { id, name } = await resolveVm(ctx);
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
    const resp = await ctx.api().patch(['vms', id, 'resize'], body);
    const data = {
      ...(resp?.vm ?? {}),
      charged: resp?.charged,
      newMonthlyCost: resp?.newMonthlyCost,
    };
    return {
      data,
      render: (v, ui) => ({
        lines: [
          checkmark(
            ui,
            `Resized ${name}${resp?.newMonthlyCost != null ? ` · ${moneyMo(resp.newMonthlyCost)}/mo`.replace('/mo/mo', '/mo') : ''}`,
          ),
        ],
      }),
    };
  },
});

register({
  path: ['vms', 'rename'],
  summary: 'Rename a VM',
  args: [
    { name: 'id', required: false, description: 'VM name or ID' },
    { name: 'name', required: true, description: 'New name' },
  ],
  flags: {},
  scope: 'vms:write',
  examples: ['bitqate vms rename dizzy-puma web-2'],
  async run(ctx) {
    const { id, name: old } = await resolveVm(ctx);
    const resp = await ctx
      .api()
      .patch(['vms', id, 'name'], { name: ctx.args[1] });
    const data = resp?.vm ?? { id, name: ctx.args[1] };
    return {
      data,
      render: (v, ui) => ({
        lines: [checkmark(ui, `Renamed ${old} → ${ctx.args[1]}`)],
      }),
    };
  },
});

register({
  path: ['vms', 'auto-renew'],
  summary: 'Turn auto-renew on or off',
  args: [
    { name: 'id', required: false, description: 'VM name or ID' },
    { name: 'state', required: true, description: 'on or off' },
  ],
  flags: {},
  scope: 'vms:write',
  examples: ['bitqate vms auto-renew dizzy-puma on'],
  async run(ctx) {
    const state = ctx.args[1];
    if (state !== 'on' && state !== 'off')
      throw usageError("Expected 'on' or 'off'");
    const { id, name } = await resolveVm(ctx);
    await ctx
      .api()
      .patch(['vms', id, 'auto-renew'], { auto_renew: state === 'on' });
    return ok({ id, auto_renew: state === 'on' }, '');
  },
});

register({
  path: ['vms', 'renew'],
  summary: 'Renew for 30 days',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {},
  scope: 'vms:write',
  charges: true,
  examples: ['bitqate vms renew dizzy-puma'],
  async run(ctx) {
    const { id, name } = await resolveVm(ctx);
    const resp = await ctx.api().post(['vms', id, 'renew']);
    return {
      data: { id, expires_at: resp?.expires_at },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Renewed ${name} for 30 days`)],
      }),
    };
  },
});

register({
  path: ['vms', 'reinstall'],
  summary: 'Reinstall from a fresh OS image',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    os: {
      type: 'string',
      placeholder: 'os',
      required: true,
      description: 'Operating system name or ID',
    },
  },
  scope: 'vms:delete',
  destructive: true,
  confirmInside: true,
  examples: ['bitqate vms reinstall dizzy-puma --os "debian 12"'],
  async run(ctx) {
    const { id, name } = await resolveVm(ctx);
    await confirmDestroy(ctx, name);
    const os = await resolveOption(
      ctx,
      ['operating-systems'],
      ctx.flags.os,
      ['id', 'name'],
      'OS',
    );
    const resp = await ctx.api().post(['vms', id, 'reinstall'], {
      operating_system_id: os,
    });
    return {
      data: { ...(resp?.vm ?? {}), message: resp?.message },
      render: (v, ui) => ({ lines: [checkmark(ui, `Reinstalling ${name}`)] }),
    };
  },
});

register({
  path: ['vms', 'delete'],
  summary: 'Delete a VM',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {},
  scope: 'vms:delete',
  destructive: true,
  confirmInside: true,
  aliases: ['rm'],
  examples: ['bitqate vms delete dizzy-puma --yes'],
  async run(ctx) {
    const { id, name } = await resolveVm(ctx);
    await confirmDestroy(ctx, name);
    const resp = await ctx.api().delete(['vms', id]);
    return {
      data: { id, refunded: resp?.refunded, message: resp?.message },
      render: (v, ui) => ({ lines: [checkmark(ui, `Deleted ${name}`)] }),
    };
  },
});

register({
  path: ['vms', 'backups', 'list'],
  summary: 'List backups',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {},
  scope: 'vms:read',
  aliases: ['ls'],
  examples: ['bitqate vms backups list dizzy-puma'],
  async run(ctx) {
    const { id } = await resolveVm(ctx);
    const resp = await ctx.api().get(['vms', id, 'backups']);
    const data = resp?.backups ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          columns: [
            { title: 'Token' },
            { title: 'Name' },
            { title: 'Size', priority: 2 },
            { title: 'Created', priority: 4 },
          ],
          rows: rows.map((b) => [
            b.token ?? b.volid ?? '',
            b.name ?? '',
            b.size != null ? String(b.size) : '',
            relTime(b.created_at ?? b.ctime),
          ]),
          footer: rows.length
            ? undefined
            : 'No backups yet. Create one with `bitqate vms backups create`.',
        },
      }),
    };
  },
});

register({
  path: ['vms', 'backups', 'create'],
  summary: 'Create a backup',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {},
  scope: 'vms:write',
  aliases: ['new'],
  examples: ['bitqate vms backups create dizzy-puma'],
  async run(ctx) {
    const { id, name } = await resolveVm(ctx);
    const resp = await ctx.api().post(['vms', id, 'backups']);
    return {
      data: { id, message: resp?.message ?? '' },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Backup started for ${name}`)],
      }),
    };
  },
});

register({
  path: ['vms', 'backups', 'restore'],
  summary: 'Restore a backup',
  args: [
    { name: 'id', required: false, description: 'VM name or ID' },
    { name: 'token', required: true, description: 'Backup token' },
  ],
  flags: {},
  scope: 'vms:delete',
  destructive: true,
  confirmInside: true,
  examples: ['bitqate vms backups restore dizzy-puma <token> --yes'],
  async run(ctx) {
    const { id, name } = await resolveVm(ctx);
    await confirmDestroy(ctx, `${name} backup ${ctx.args[1]}`);
    const resp = await ctx
      .api()
      .post(['vms', id, 'backups', ctx.args[1], 'restore']);
    return {
      data: { id, message: resp?.message ?? '' },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Restoring ${name} from backup`)],
      }),
    };
  },
});

register({
  path: ['vms', 'backups', 'delete'],
  summary: 'Delete a backup',
  args: [
    { name: 'id', required: false, description: 'VM name or ID' },
    { name: 'token', required: true, description: 'Backup token' },
  ],
  flags: {},
  scope: 'vms:delete',
  destructive: true,
  confirmInside: true,
  examples: ['bitqate vms backups delete dizzy-puma <token> --yes'],
  async run(ctx) {
    const { id, name } = await resolveVm(ctx);
    await confirmDestroy(ctx, `${name} backup ${ctx.args[1]}`);
    const resp = await ctx.api().delete(['vms', id, 'backups', ctx.args[1]]);
    return {
      data: { id, message: resp?.message ?? '' },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Deleted backup of ${name}`)],
      }),
    };
  },
});

register({
  path: ['vms', 'networking'],
  summary: 'Show network addresses',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {},
  scope: 'vms:read',
  examples: ['bitqate vms networking dizzy-puma'],
  async run(ctx) {
    const { id } = await resolveVm(ctx);
    const resp = await ctx.api().get(['vms', id, 'networking']);
    const data = resp?.ips ?? resp;
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          columns: [
            { title: 'Address' },
            { title: 'Version', priority: 1 },
            { title: 'CIDR', priority: 2 },
            { title: 'rDNS', priority: 4 },
          ],
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
  summary: 'Set reverse DNS',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    address: {
      type: 'string',
      placeholder: 'ip',
      required: true,
      description: 'IP address',
    },
    hostname: {
      type: 'string',
      placeholder: 'host',
      required: true,
      description: 'rDNS hostname',
    },
  },
  scope: 'vms:write',
  examples: [
    'bitqate vms rdns dizzy-puma --address 203.0.113.10 --hostname mail.example.com',
  ],
  async run(ctx) {
    const { id, name } = await resolveVm(ctx);
    const resp = await ctx.api().put(['vms', id, 'networking', 'rdns'], {
      address: ctx.flags.address,
      rdns: ctx.flags.hostname,
    });
    return {
      data: { id, rdns: resp?.rdns, dnsSynced: resp?.dnsSynced },
      render: (v, ui) => ({ lines: [checkmark(ui, `Set rDNS for ${name}`)] }),
    };
  },
});

register({
  path: ['vms', 'stats'],
  summary: 'Show usage statistics',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    range: {
      type: 'string',
      placeholder: 'range',
      description: 'hour, day, week, month or year',
    },
    cf: { type: 'string', placeholder: 'cf', description: 'AVERAGE or MAX' },
  },
  scope: 'vms:read',
  examples: ['bitqate vms stats dizzy-puma --range day'],
  async run(ctx) {
    const { id } = await resolveVm(ctx);
    const resp = await ctx.api().get(['vms', id, 'stats'], {
      range: ctx.flags.range,
      cf: ctx.flags.cf,
    });
    const data = resp?.stats ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          columns: [
            { title: 'Time' },
            { title: 'CPU %' },
            { title: 'Mem %', priority: 2 },
            { title: 'Disk %', priority: 3 },
          ],
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
  summary: 'Wait for a status',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    status: {
      type: 'string',
      placeholder: 'status',
      required: true,
      description: 'Target status',
    },
    'wait-timeout': {
      type: 'string',
      placeholder: 'seconds',
      description: 'Seconds before giving up',
    },
  },
  scope: 'vms:read',
  examples: ['bitqate vms wait dizzy-puma --status running'],
  async run(ctx) {
    const resolved = await resolveVm(ctx);
    const target = ctx.flags.status;
    const fail = new Set([...VM_FAIL].filter((s) => s !== target));
    const vm = await waitForVm(
      ctx,
      resolved,
      new Set([target]),
      fail,
      'Waiting for',
    );
    return {
      data: vm,
      render: (v) => ({ lines: [`${v.name ?? v.id} is ${v.status}`] }),
    };
  },
});

register({
  path: ['vms', 'ssh'],
  summary: 'Connect over SSH',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {
    user: {
      type: 'string',
      placeholder: 'user',
      description: 'SSH user (default root)',
    },
    '--': {
      type: 'string',
      multiple: true,
      placeholder: 'args',
      description: 'Extra ssh args',
    },
  },
  scope: 'vms:read',
  examples: [
    'bitqate vms ssh dizzy-puma',
    'bitqate vms ssh dizzy-puma --user debian',
  ],
  async run(ctx) {
    return sshInto(ctx, ctx.args[0]);
  },
});

register({
  path: ['vms', 'open'],
  summary: 'Open a VM in the dashboard',
  args: [{ name: 'id', required: false, description: 'VM name or ID' }],
  flags: {},
  scope: 'vms:read',
  examples: ['bitqate vms open dizzy-puma'],
  async run(ctx) {
    const { id } = await resolveVm(ctx);
    const url = portalUrl('vm', id);
    if (!ctx.io.json && ctx.io.interactive) await openUrl(url);
    return { data: { url }, render: (d) => ({ lines: [`Opening ${d.url}`] }) };
  },
});
