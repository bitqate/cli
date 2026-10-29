import { readFileSync } from 'node:fs';
import { CliError, usageError } from '../core/errors';
import { confirmDestroy, waitPoll } from '../core/confirm';
import { openUrl, portalUrl } from '../core/portal';
import { priceMap, serverMonthly } from '../core/pricing';
import { resolveOption, resolveResource } from '../core/resolve';
import { detailToLines, sanitize } from '../core/output';
import { findGame, GAMES } from '../data/games';
import { task } from '../ui/spinner';
import { confirm, select, text } from '../ui/prompts';
import {
  bytes,
  elapsedLong,
  memory,
  money,
  moneyMo,
  relTime,
  shortId,
} from '../ui/format';
import { statusText } from '../ui/theme';
import { cpusToUnits, parseEnvPairs, positiveInt } from '../core/validate';
import { register, type RunContext } from '../registry';
import { serverWizard } from '../wizards/server';
import { followDeployment } from './deploy-follow';
import {
  collectSourceFiles,
  gitInfo,
  packSource,
} from '../core/source-archive';
import { statSync } from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9 ._-]+$/;

function checkmark(ui: { theme: any }, msg: string): string {
  return `${ui.theme.paint('success', ui.theme.glyph('check'))} ${msg}`;
}

function waitTimeoutMs(ctx: RunContext): number {
  const v = ctx.flags['wait-timeout'];
  return v ? positiveInt(String(v), 'wait-timeout') * 1000 : 600_000;
}

async function resolveSrv(ctx: RunContext, ref?: string) {
  return resolveResource(ctx, 'servers', ref ?? ctx.args[0], ctx.io.theme);
}

async function waitForServerStatus(
  ctx: RunContext,
  resolved: { id: string; name: string },
  targets: Set<string>,
  label: string,
) {
  return task(
    `${label} ${resolved.name}`,
    ctx.io.theme,
    async (t) =>
      waitPoll(
        { name: resolved.name, kind: 'servers' },
        async () => {
          const resp = await ctx.api().get(['servers', resolved.id]);
          const server = resp?.server;
          const status = server?.status ?? 'unknown';
          t.update(status);
          if (targets.has(status)) return { value: server, status };
          if (status === 'suspended')
            throw new CliError('server', "Server entered state 'suspended'");
          return { value: null, status };
        },
        { timeoutMs: waitTimeoutMs(ctx), label },
      ),
    { endStyle: 'ok' },
  );
}

async function waitForInstall(
  ctx: RunContext,
  resolved: { id: string; name: string },
) {
  return task(
    `Installing ${resolved.name}`,
    ctx.io.theme,
    async (t) =>
      waitPoll(
        { name: resolved.name, kind: 'servers' },
        async () => {
          const resp = await ctx
            .api()
            .get(['servers', resolved.id, 'install-state']);
          const status = resp?.installState ?? 'unknown';
          t.update(status);
          if (status === 'installed')
            return { value: { id: resolved.id, installState: status }, status };
          if (status === 'failed')
            throw new CliError('server', 'Server installation failed');
          return { value: null, status };
        },
        { timeoutMs: waitTimeoutMs(ctx), label: 'install' },
      ),
    { endStyle: 'ok' },
  );
}

register({
  path: ['servers', 'list'],
  summary: 'List your servers',
  args: [],
  flags: {},
  scope: 'servers:read',
  aliases: ['ls'],
  examples: ['bitqate servers list', 'bitqate servers ls -q'],
  async run(ctx) {
    const resp = await ctx.api().get(['servers']);
    const data = resp?.servers ?? [];
    return {
      data,
      render: (rows: any[], ui) => {
        if (!rows.length)
          return {
            lines: [
              'No servers yet. Create one with `bitqate servers create`.',
            ],
          };
        const online = rows.filter((s) => s.status === 'online').length;
        const tty = !!process.stdout.isTTY;
        return {
          table: {
            columns: [
              { title: 'Name', truncate: true },
              { title: 'ID', priority: 1 },
              { title: 'Status', priority: 8 },
              { title: 'Kind', priority: 1 },
              { title: 'Address', priority: 4 },
              { title: 'Size', priority: 2 },
              { title: 'Created', priority: 0 },
            ],
            rows: rows.map((s) => [
              s.name ?? '',
              tty ? shortId(s.id ?? '') : (s.id ?? ''),
              statusText(ui.theme, s.status ?? ''),
              s.kind ?? '',
              s.address ? `${s.address.host}:${s.address.port}` : '',
              `${s.resources?.cpu_cores ?? ''} vCPU · ${memory(s.resources?.memory_mb ?? 0)} · ${s.resources?.disk_gb ?? ''} GB`,
              relTime(s.created_at),
            ]),
            footer: `${rows.length} server${rows.length === 1 ? '' : 's'} · ${online} online`,
          },
        };
      },
    };
  },
});

register({
  path: ['servers', 'get'],
  summary: 'Show one server',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:read',
  aliases: ['show', 'info'],
  examples: ['bitqate servers get api'],
  async run(ctx) {
    const { id } = await resolveSrv(ctx);
    const resp = await ctx.api().get(['servers', id]);
    const server = resp?.server;
    if (!server) throw new CliError('not_found', `Server '${id}' not found`);
    const data = server;
    return {
      data,
      render: (s: any, ui) => ({
        detail: {
          title: `${s.name ?? ''}  ${statusText(ui.theme, s.status ?? '')}`,
          id: s.id,
          fields: [
            ['Kind', s.kind],
            [
              'Image',
              s.kind === 'git' || s.kind === 'dockerfile'
                ? undefined
                : (s.image ?? s.egg_url),
            ],
            [
              'Region',
              s.region
                ? `${s.region.name}${s.region.location ? ` (${s.region.location})` : ''}`
                : undefined,
            ],
            [
              'Size',
              `${s.resources?.cpu_cores ?? 0} vCPU · ${memory(s.resources?.memory_mb ?? 0)} RAM · ${s.resources?.disk_gb ?? 0} GB disk`,
            ],
            [
              'Address',
              s.address ? `${s.address.host}:${s.address.port}` : undefined,
            ],
            [
              'Extra ports',
              (s.extra_ports ?? []).length
                ? JSON.stringify(s.extra_ports)
                : undefined,
            ],
            ['Created', relTime(s.created_at)],
            [
              'Renews',
              `${relTime(s.expires_at)} · auto-renew ${s.auto_renew ? 'on' : 'off'}`,
            ],
            ['Suspended', s.suspended ? 'yes' : undefined],
          ],
          hints: [
            [`bitqate servers open ${s.name ?? s.id}`, 'open in the dashboard'],
            ...(s.kind === 'git'
              ? ([
                  [
                    `bitqate servers deploy ${s.name ?? s.id}`,
                    'deploy from git',
                  ],
                ] as [string, string][])
              : []),
          ],
        },
      }),
    };
  },
});

register({
  path: ['servers', 'regions'],
  summary: 'List regions',
  args: [],
  flags: {},
  scope: 'any',
  examples: ['bitqate servers regions'],
  async run(ctx) {
    const resp = await ctx.api().get(['daemons']);
    const data = resp?.daemons ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          columns: [{ title: 'ID' }, { title: 'Name' }, { title: 'Location' }],
          rows: rows.map((d) => [d.id ?? '', d.name ?? '', d.location ?? '']),
          footer: rows.length ? undefined : 'No regions available.',
        },
      }),
    };
  },
});

const SERVER_SIZES = [
  { cpu: 50, mem: 512, disk: 5 },
  { cpu: 100, mem: 1024, disk: 10 },
  { cpu: 100, mem: 2048, disk: 20 },
  { cpu: 200, mem: 4096, disk: 40 },
  { cpu: 400, mem: 8192, disk: 80 },
];

register({
  path: ['servers', 'create'],
  summary: 'Create a server',
  args: [],
  flags: {
    name: { type: 'string', placeholder: 'name', description: 'Server name' },
    region: {
      type: 'string',
      placeholder: 'region',
      description: 'Region name, location or ID',
    },
    'memory-mb': {
      type: 'string',
      placeholder: 'mb',
      description: 'Memory in MB',
    },
    cpus: {
      type: 'string',
      placeholder: 'n',
      description: 'CPU cores (e.g. 1.5)',
    },
    'disk-gb': { type: 'string', placeholder: 'gb', description: 'Disk in GB' },
    image: {
      type: 'string',
      placeholder: 'image',
      description: 'Container image reference',
    },
    'egg-url': {
      type: 'string',
      placeholder: 'url',
      description: 'Game egg URL',
    },
    game: {
      type: 'string',
      placeholder: 'name',
      description: 'Game from the catalog (e.g. Paper)',
    },
    dockerfile: {
      type: 'string',
      placeholder: 'path',
      description:
        'Path to a Dockerfile (max 64 KB); with --dir, a path inside it',
    },
    git: { type: 'boolean', description: 'Build from a connected git repo' },
    dir: {
      type: 'string',
      placeholder: 'path',
      description: 'Upload and deploy a local directory',
    },
    env: {
      type: 'string',
      placeholder: 'KEY=VALUE',
      multiple: true,
      description: 'KEY=VALUE (repeatable)',
    },
    startup: {
      type: 'string',
      placeholder: 'command',
      description: 'Startup command',
    },
    workspace: {
      type: 'string',
      placeholder: 'workspace',
      description: 'Workspace name or ID',
    },
    wait: {
      type: 'boolean',
      description: 'Wait for installation, or for the first deploy with --dir',
    },
    'wait-timeout': {
      type: 'string',
      placeholder: 'seconds',
      description: 'Seconds before giving up',
    },
  },
  scope: 'servers:write',
  charges: true,
  interactive: true,
  aliases: ['new'],
  examples: [
    'bitqate servers create',
    'bitqate servers create --name api --region ca-mo-01 --memory-mb 1024 --cpus 1 --disk-gb 10 --image ghcr.io/org/app:latest',
    'bitqate servers create --game paper',
  ],
  async run(ctx) {
    const sources = [
      ctx.flags.image,
      ctx.flags['egg-url'],
      ctx.flags.game,
      ctx.flags.dockerfile && !ctx.flags.dir ? ctx.flags.dockerfile : undefined,
      ctx.flags.git,
      ctx.flags.dir,
    ].filter((v) => v !== undefined && v !== false);
    if (sources.length > 1)
      throw usageError(
        'Pass only one of --image, --egg-url, --game, --dockerfile, --git or --dir',
      );

    const missingRequired =
      !ctx.flags.name ||
      !ctx.flags.region ||
      !ctx.flags['memory-mb'] ||
      !ctx.flags.cpus ||
      !ctx.flags['disk-gb'] ||
      !sources.length;
    const useWizard = ctx.io.interactive && !ctx.io.json && missingRequired;

    let body: Record<string, unknown>;
    let mode: string;
    let name: string;
    let wizardDir: string | undefined;
    if (!useWizard) {
      if (sources.length !== 1)
        throw usageError(
          'Pass exactly one of --image, --egg-url, --game, --dockerfile, --git or --dir',
        );
      const region = await resolveOption(
        ctx,
        ['daemons'],
        ctx.flags.region,
        ['id', 'name', 'location'],
        'region',
      );
      body = {
        name: ctx.flags.name,
        daemonId: region,
        ram: positiveInt(ctx.flags['memory-mb'], 'memory-mb'),
        cpu: cpusToUnits(ctx.flags.cpus, 'cpus'),
        disk: positiveInt(ctx.flags['disk-gb'], 'disk-gb'),
      };
      if (ctx.flags.image) {
        body.mode = 'image';
        body.image = ctx.flags.image;
      } else if (ctx.flags['egg-url']) {
        body.mode = 'egg';
        body.eggUrl = ctx.flags['egg-url'];
      } else if (ctx.flags.game) {
        const g = findGame(ctx.flags.game);
        if (!g)
          throw usageError(
            `Unknown game '${ctx.flags.game}' (see the catalog)`,
          );
        body.mode = 'egg';
        body.eggUrl = g.eggUrl;
        body.image = g.image;
        body.startup = g.startup;
        body.variables = { ...g.variables };
      } else if (ctx.flags.dockerfile && !ctx.flags.dir) {
        body.mode = 'dockerfile';
        let content: string;
        try {
          content = readFileSync(ctx.flags.dockerfile, 'utf8');
        } catch {
          throw usageError(`Cannot read ${ctx.flags.dockerfile}`);
        }
        if (Buffer.byteLength(content) > 65536)
          throw usageError('Dockerfile too large (max 64 KB)');
        body.dockerfile = content;
      } else {
        body.mode = 'git';
      }
      if (ctx.flags.env?.length)
        body.variables = {
          ...(body.variables as object),
          ...parseEnvPairs(ctx.flags.env),
        };
      if (ctx.flags.startup) body.startup = ctx.flags.startup;
      if (ctx.flags.workspace)
        body.teamId = await resolveOption(
          ctx,
          ['workspaces'],
          ctx.flags.workspace,
          ['id', 'name'],
          'workspace',
        );
      mode = body.mode as string;
      name = ctx.flags.name;
    } else {
      const w = await serverWizard(ctx);
      ({ body, mode, name } = w);
      wizardDir = w.dir;
    }

    const dir = ctx.flags.dir ?? wizardDir;
    const pkg = dir ? await packageDir(ctx, String(dir)) : null;

    const t0 = Date.now();
    const resp = await task('Creating server', ctx.io.theme, () =>
      ctx.api().post(['servers'], body),
    );
    const id = resp?.id;
    if (!id) throw new CliError('server', 'Unexpected create response');
    const ref = /\s/.test(name) ? `"${name}"` : name;

    if (pkg) {
      let up: any;
      try {
        up = await uploadPackage(ctx, id, pkg);
      } catch (e) {
        throw new CliError(
          'server',
          `Created ${name}, but the upload failed: ${e instanceof Error ? e.message : e}. Retry with: bitqate servers deploy ${ref} --dir ${dir}`,
        );
      }
      const packed = pkg;
      if (ctx.flags.wait && up?.deploymentId) {
        const dep = await followDeployment(
          ctx,
          { id, name },
          up.deploymentId,
          waitTimeoutMs(ctx),
        );
        if (dep.status === 'failed')
          throw new CliError('server', 'Deployment failed');
        const secs = (Date.now() - t0) / 1000;
        return {
          data: {
            id,
            name,
            mode,
            deploymentId: up.deploymentId,
            status: dep.status,
          },
          render: (_d, ui) => ({
            lines: [
              checkmark(ui, `${name} is deployed (${elapsedLong(secs)})`),
            ],
          }),
        };
      }
      return {
        data: {
          id,
          name,
          mode,
          deploymentId: up?.deploymentId,
          status: up?.status,
        },
        render: (_d, ui) => ({
          lines: [
            checkmark(
              ui,
              `Created ${name} and uploaded ${packed.files} files (${bytes(packed.data.length)})`,
            ),
            ui.theme.paint(
              'muted',
              `Follow with: bitqate servers deployments logs ${ref} ${up?.deploymentId}`,
            ),
          ],
        }),
      };
    }
    const data: Record<string, unknown> = { id, name, mode };
    if (mode === 'git' && !ctx.flags.dir)
      data.hint = `Connect the git repository in the dashboard, or upload code with: bitqate servers deploy ${ref} --dir .`;

    if (ctx.flags.wait && mode === 'egg') {
      await waitForInstall(ctx, { id, name });
      const secs = (Date.now() - t0) / 1000;
      return {
        data,
        render: (d, ui) => ({
          lines: [checkmark(ui, `${name} is installed (${elapsedLong(secs)})`)],
        }),
      };
    }

    return {
      data,
      render: (d, ui) => ({
        lines: [
          mode === 'egg'
            ? checkmark(ui, `${name} is now being installed`)
            : checkmark(ui, `Created ${name}`),
          ...(mode === 'egg'
            ? [
                `  ${ui.theme.paint('muted', `Check progress with bitqate servers install-state ${ref}`)}`,
              ]
            : []),
          ...(d.hint ? [`  ${ui.theme.paint('muted', d.hint)}`] : []),
        ],
      }),
    };
  },
});

for (const op of ['start', 'stop', 'restart'] as const) {
  register({
    path: ['servers', op],
    summary: `${op[0].toUpperCase() + op.slice(1)} a server`,
    args: [{ name: 'id', required: false, description: 'Server name or ID' }],
    flags: {
      wait: { type: 'boolean', description: 'Wait until it finishes' },
      'wait-timeout': {
        type: 'string',
        placeholder: 'seconds',
        description: 'Seconds before giving up',
      },
    },
    scope: 'servers:power',
    examples: [`bitqate servers ${op} api --wait`],
    async run(ctx) {
      const resolved = await resolveSrv(ctx);
      await ctx.api().post(['servers', resolved.id, op]);
      if (!ctx.flags.wait) return { data: { id: resolved.id } };
      const targets =
        op === 'stop' ? new Set(['offline']) : new Set(['online']);
      const server = await waitForServerStatus(
        ctx,
        resolved,
        targets,
        `${op[0].toUpperCase() + op.slice(1)}ing`,
      );
      return {
        data: server,
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
  path: ['servers', 'reinstall'],
  summary: 'Reinstall the server',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {
    image: {
      type: 'string',
      placeholder: 'image',
      description: 'New image reference',
    },
    'egg-url': {
      type: 'string',
      placeholder: 'url',
      description: 'New egg URL',
    },
  },
  scope: 'servers:delete',
  destructive: true,
  confirmInside: true,
  examples: ['bitqate servers reinstall api --image nginx:latest --yes'],
  async run(ctx) {
    if (ctx.flags.image && ctx.flags['egg-url'])
      throw usageError('Pass only one of --image or --egg-url');
    const { id, name } = await resolveSrv(ctx);
    await confirmDestroy(ctx, name);
    const body: Record<string, unknown> = {};
    if (ctx.flags.image) body.image = ctx.flags.image;
    if (ctx.flags['egg-url']) body.eggUrl = ctx.flags['egg-url'];
    const resp = await ctx.api().post(['servers', id, 'reinstall'], body);
    return {
      data: { id, message: resp?.message ?? '' },
      render: (v, ui) => ({ lines: [checkmark(ui, `Reinstalling ${name}`)] }),
    };
  },
});

register({
  path: ['servers', 'renew'],
  summary: 'Renew for 30 days',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:write',
  charges: true,
  examples: ['bitqate servers renew api'],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    await ctx.api().post(['servers', id, 'renew']);
    return {
      data: { id },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Renewed ${name} for 30 days`)],
      }),
    };
  },
});

register({
  path: ['servers', 'auto-renew'],
  summary: 'Turn auto-renew on or off',
  args: [
    { name: 'id', required: false, description: 'Server name or ID' },
    { name: 'state', required: true, description: 'on or off' },
  ],
  flags: {},
  scope: 'servers:write',
  examples: ['bitqate servers auto-renew api on'],
  async run(ctx) {
    const state = ctx.args[1];
    if (state !== 'on' && state !== 'off')
      throw usageError("Expected 'on' or 'off'");
    const { id, name } = await resolveSrv(ctx);
    await ctx.api().put(['servers', id, 'auto-renew'], {
      auto_renew: state === 'on',
    });
    return {
      data: { id, auto_renew: state === 'on' },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Auto-renew ${state} for ${name}`)],
      }),
    };
  },
});

register({
  path: ['servers', 'rename'],
  summary: 'Rename a server',
  args: [
    { name: 'id', required: false, description: 'Server name or ID' },
    { name: 'name', required: true, description: 'New name' },
  ],
  flags: {},
  scope: 'servers:write',
  examples: ['bitqate servers rename api api-2'],
  async run(ctx) {
    const { id, name: old } = await resolveSrv(ctx);
    await ctx.api().put(['servers', id, 'name'], { name: ctx.args[1] });
    return {
      data: { id, name: ctx.args[1] },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Renamed ${old} → ${ctx.args[1]}`)],
      }),
    };
  },
});

register({
  path: ['servers', 'resize'],
  summary: 'Change CPU, memory or disk',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {
    'memory-mb': {
      type: 'string',
      placeholder: 'mb',
      description: 'Memory in MB',
    },
    cpus: {
      type: 'string',
      placeholder: 'n',
      description: 'CPU cores (e.g. 1.5)',
    },
    'disk-gb': { type: 'string', placeholder: 'gb', description: 'Disk in GB' },
  },
  scope: 'servers:write',
  charges: true,
  examples: ['bitqate servers resize api --memory-mb 2048 --cpus 2'],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    const body: Record<string, unknown> = {};
    if (ctx.flags['memory-mb'] !== undefined)
      body.ram = positiveInt(ctx.flags['memory-mb'], 'memory-mb');
    if (ctx.flags.cpus !== undefined)
      body.cpu = cpusToUnits(ctx.flags.cpus, 'cpus');
    if (ctx.flags['disk-gb'] !== undefined)
      body.disk = positiveInt(ctx.flags['disk-gb'], 'disk-gb');
    if (!Object.keys(body).length)
      throw usageError('Pass at least one of --memory-mb, --cpus or --disk-gb');
    const resp = await ctx.api().patch(['servers', id, 'resize'], body);
    const data = {
      ...(resp?.server ?? {}),
      charged: resp?.charged,
      newMonthlyCost: resp?.newMonthlyCost,
    };
    return {
      data,
      render: (v, ui) => ({ lines: [checkmark(ui, `Resized ${name}`)] }),
    };
  },
});

register({
  path: ['servers', 'ports'],
  summary: 'Set extra ports',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {
    port: {
      type: 'string',
      placeholder: 'port',
      multiple: true,
      description: 'internalPort[:tcp|udp], repeatable; omit all to clear',
    },
  },
  scope: 'servers:write',
  examples: ['bitqate servers ports mc --port 25566:udp --port 8080'],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    const ports = (ctx.flags.port ?? []).map((p: string) => {
      const [num, proto] = p.split(':');
      const internalPort = Number(num);
      if (
        !Number.isInteger(internalPort) ||
        internalPort < 1024 ||
        internalPort > 65535
      )
        throw usageError(
          `Invalid --port '${p}' (expected internalPort[:tcp|udp], 1024-65535)`,
        );
      const entry: Record<string, unknown> = { internalPort };
      if (proto) {
        if (proto !== 'tcp' && proto !== 'udp')
          throw usageError(`Invalid protocol '${proto}' (tcp or udp)`);
        entry.protocol = proto;
      }
      return entry;
    });
    const resp = await ctx.api().put(['servers', id, 'ports'], { ports });
    return {
      data: { id, ports: resp?.ports ?? [], limit: resp?.limit },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Updated ports for ${name}`)],
      }),
    };
  },
});

register({
  path: ['servers', 'startup'],
  summary: 'Set startup command and env',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {
    command: {
      type: 'string',
      placeholder: 'command',
      description: 'Startup command',
    },
    env: {
      type: 'string',
      placeholder: 'KEY=VALUE',
      multiple: true,
      description: 'KEY=VALUE (repeatable)',
    },
  },
  scope: 'servers:write',
  examples: [
    'bitqate servers startup api --command "./run.sh" --env MODE=prod',
  ],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    const body: Record<string, unknown> = {};
    if (ctx.flags.command !== undefined) body.startup = ctx.flags.command;
    if (ctx.flags.env?.length) body.variables = parseEnvPairs(ctx.flags.env);
    if (!Object.keys(body).length) throw usageError('Pass --command or --env');
    const resp = await ctx.api().put(['servers', id, 'startup'], body);
    return {
      data: { id, startup: resp?.startup, variables: resp?.variables },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Updated startup for ${name}`)],
      }),
    };
  },
});

register({
  path: ['servers', 'install-state'],
  summary: 'Show install state',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:read',
  examples: ['bitqate servers install-state mc'],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    const resp = await ctx.api().get(['servers', id, 'install-state']);
    const data = { id, name, installState: resp?.installState };
    return {
      data,
      render: (v, ui) => ({
        lines: [
          `${name}: ${statusText(ui.theme, v.installState ?? 'unknown')}`,
        ],
      }),
    };
  },
});

register({
  path: ['servers', 'delete'],
  summary: 'Delete a server',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:delete',
  destructive: true,
  confirmInside: true,
  aliases: ['rm'],
  examples: ['bitqate servers delete api --yes'],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    const preview = await ctx.api().get(['servers', id, 'delete-preview']);
    if (!ctx.io.yes && !ctx.flags['dry-run']) {
      if (ctx.io.json || !ctx.io.interactive)
        throw new CliError('usage', 'Deleting is destructive.', {
          hint: 'pass --yes to confirm',
        });
      process.stderr.write(
        `This will permanently destroy ${sanitize(name)}.  ${ctx.io.theme.paint('muted', `Refund ${money(preview?.refund ?? 0)} to your account balance`)} · backups ${preview?.backups?.count ?? 0} (${bytes(preview?.backups?.size_bytes ?? 0)})\n`,
      );
      const { text } = await import('../ui/prompts');
      const typed = await text(
        { message: `Type '${name}' to confirm` },
        ctx.io.theme,
      );
      if (typed !== name)
        throw usageError('Confirmation did not match; aborted.');
    }
    const resp = await ctx.api().delete(['servers', id]);
    const data = {
      id,
      preview,
      refunded: resp?.refunded,
      message: resp?.message,
    };
    return {
      data,
      render: (v, ui) => ({ lines: [checkmark(ui, `Deleted ${name}`)] }),
    };
  },
});

register({
  path: ['servers', 'backups', 'list'],
  summary: 'List backups',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:read',
  aliases: ['ls'],
  examples: ['bitqate servers backups list api'],
  async run(ctx) {
    const { id } = await resolveSrv(ctx);
    const resp = await ctx.api().get(['servers', id, 'backups']);
    const data = resp?.backups ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          columns: [
            { title: 'ID' },
            { title: 'Status', priority: 4 },
            { title: 'Size', priority: 2 },
            { title: 'Created', priority: 6 },
          ],
          rows: rows.map((b: any) => [
            b.id ?? '',
            b.status ?? '',
            b.size_bytes != null ? bytes(b.size_bytes) : '',
            relTime(b.created_at),
          ]),
          footer: rows.length
            ? undefined
            : 'No backups yet. Create one with `bitqate servers backups create`.',
        },
      }),
    };
  },
});

register({
  path: ['servers', 'backups', 'create'],
  summary: 'Create a backup',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:write',
  aliases: ['new'],
  examples: ['bitqate servers backups create api'],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    const resp = await ctx.api().post(['servers', id, 'backups']);
    return {
      data: resp?.backup ?? { id },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Backup started for ${name}`)],
      }),
    };
  },
});

register({
  path: ['servers', 'backups', 'restore'],
  summary: 'Restore a backup',
  args: [
    { name: 'id', required: false, description: 'Server name or ID' },
    { name: 'backupId', required: true, description: 'Backup ID' },
  ],
  flags: {},
  scope: 'servers:delete',
  destructive: true,
  confirmInside: true,
  examples: ['bitqate servers backups restore api bak_1 --yes'],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    await confirmDestroy(ctx, `${name} backup ${ctx.args[1]}`);
    await ctx.api().post(['servers', id, 'backups', ctx.args[1], 'restore']);
    return {
      data: { id, backupId: ctx.args[1], restored: true },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Restoring ${name} from backup`)],
      }),
    };
  },
});

register({
  path: ['servers', 'backups', 'delete'],
  summary: 'Delete a backup',
  args: [
    { name: 'id', required: false, description: 'Server name or ID' },
    { name: 'backupId', required: true, description: 'Backup ID' },
  ],
  flags: {},
  scope: 'servers:delete',
  destructive: true,
  confirmInside: true,
  examples: ['bitqate servers backups delete api bak_1 --yes'],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    await confirmDestroy(ctx, `${name} backup ${ctx.args[1]}`);
    await ctx.api().delete(['servers', id, 'backups', ctx.args[1]]);
    return {
      data: { id, backupId: ctx.args[1], deleted: true },
      render: (v, ui) => ({
        lines: [checkmark(ui, `Deleted backup of ${name}`)],
      }),
    };
  },
});

register({
  path: ['servers', 'deploy'],
  summary: 'Deploy from git or a local directory',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {
    dir: {
      type: 'string',
      placeholder: 'path',
      description: 'Upload and deploy a local directory',
    },
    dockerfile: {
      type: 'string',
      placeholder: 'path',
      description: 'Dockerfile to use with --dir (default: Dockerfile)',
    },
    message: {
      type: 'string',
      short: 'm',
      placeholder: 'text',
      description: 'Deployment message (only with --dir)',
    },
    follow: {
      type: 'boolean',
      description: 'Stream deployment logs to the end',
    },
    'wait-timeout': {
      type: 'string',
      placeholder: 'seconds',
      description: 'Seconds before giving up',
    },
  },
  scope: 'servers:write',
  charges: true,
  examples: [
    'bitqate servers deploy api --follow',
    'bitqate servers deploy api --dir . --follow',
  ],
  async run(ctx) {
    if (!ctx.flags.dir && (ctx.flags.dockerfile || ctx.flags.message))
      throw usageError('--dockerfile and --message require --dir');
    const { id, name } = await resolveSrv(ctx);

    if (ctx.flags.dir) {
      const dir = String(ctx.flags.dir);
      let st;
      try {
        st = statSync(dir);
      } catch {
        throw usageError(`No such directory: ${dir}`);
      }
      if (!st.isDirectory()) throw usageError(`Not a directory: ${dir}`);

      const pkg = await packageDir(ctx, dir);
      const resp = await uploadPackage(ctx, id, pkg);
      const packed = pkg;
      const dockerfilePath = pkg.dockerfile;
      const data = packed.data;
      const deploymentId = resp?.deploymentId;
      const d = {
        id,
        deploymentId,
        status: resp?.status,
        files: packed.files,
        bytes: packed.bytes,
        compressedBytes: data.length,
      };
      if (ctx.flags.follow && deploymentId) {
        const dep = await followDeployment(
          ctx,
          { id, name },
          deploymentId,
          waitTimeoutMs(ctx),
        );
        if (dep.status === 'failed')
          throw new CliError('server', 'Deployment failed');
        return {
          data: { ...d, status: dep.status },
          render: (_v, ui) => ({
            lines: [checkmark(ui, `Deployment ${dep.status} for ${name}`)],
          }),
        };
      }
      const ref = /\s/.test(name) ? `"${name}"` : name;
      return {
        data: d,
        render: (_v, ui) => ({
          lines: [
            checkmark(
              ui,
              `Uploaded ${packed.files} files (${bytes(data.length)}) · deployment ${shortId(deploymentId ?? '')} building for ${name}`,
            ),
            ui.theme.paint(
              'muted',
              `Follow with: bitqate servers deployments logs ${ref} ${deploymentId}`,
            ),
            ...(resp?.gitBranch
              ? [
                  ui.theme.paint(
                    'muted',
                    `${name} also deploys from GitHub (${resp.gitBranch}); the next push replaces this upload.`,
                  ),
                ]
              : []),
          ],
        }),
      };
    }

    const resp = await ctx.api().post(['servers', id, 'deploy'], {});
    const deploymentId = resp?.deploymentId;
    if (!ctx.flags.follow || !deploymentId) {
      const data = { id, deploymentId, status: resp?.status };
      return {
        data,
        render: (v, ui) => ({
          lines: [
            checkmark(
              ui,
              `Deployment ${deploymentId ?? ''} queued for ${name}`,
            ),
          ],
        }),
      };
    }
    const dep = await followDeployment(
      ctx,
      { id, name },
      deploymentId,
      waitTimeoutMs(ctx),
    );
    if (dep.status === 'failed')
      throw new CliError('server', 'Deployment failed');
    const data = { id, deploymentId, status: dep.status };
    return {
      data,
      render: (v, ui) => ({
        lines: [checkmark(ui, `Deployment ${dep.status} for ${name}`)],
      }),
    };
  },
});

async function packageDir(
  ctx: RunContext,
  dir: string,
): Promise<{
  data: Uint8Array;
  files: number;
  bytes: number;
  names: string[];
  dockerfile: string;
  message?: string;
  info: ReturnType<typeof gitInfo>;
}> {
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw usageError(`No such directory: ${dir}`);
  }
  if (!st.isDirectory()) throw usageError(`Not a directory: ${dir}`);
  const dockerfile = resolveDeployDockerfile(ctx, dir);
  const packed = await task(`Packaging ${dir}`, ctx.io.theme, async () => {
    const { files, skipped, mode } = collectSourceFiles(dir);
    const packed = await packSource(dir, files, { dockerfile });
    return { ...packed, skipped, mode };
  });
  if (packed.skipped.length && !ctx.io.json)
    process.stderr.write(
      `${ctx.io.theme.paint('muted', `Skipped directories: ${packed.skipped.join(', ')}`)}\n`,
    );
  if (ctx.io.verbose)
    for (const f of packed.names) process.stderr.write(`${f}\n`);
  const info = packed.mode === 'git' ? gitInfo(dir) : { dirty: false };
  const message = ctx.flags.message
    ? String(ctx.flags.message)
    : info.subject
      ? info.subject + (info.dirty ? ' (uncommitted changes)' : '')
      : undefined;
  return { ...packed, dockerfile, message, info };
}

async function uploadPackage(
  ctx: RunContext,
  serverId: string,
  pkg: Awaited<ReturnType<typeof packageDir>>,
): Promise<any> {
  return task(`Uploading ${bytes(pkg.data.length)}`, ctx.io.theme, () =>
    ctx.api().upload(['servers', serverId, 'deploy', 'upload'], pkg.data, {
      query: {
        dockerfile: pkg.dockerfile,
        message: pkg.message,
        commit: pkg.info.commit,
        branch: pkg.info.branch,
      },
      summary: {
        archive: 'source.tar.gz',
        files: pkg.files,
        bytes: pkg.bytes,
        compressedBytes: pkg.data.length,
        dockerfile: pkg.dockerfile,
        query: {
          dockerfile: pkg.dockerfile,
          message: pkg.message,
          commit: pkg.info.commit,
          branch: pkg.info.branch,
        },
      },
    }),
  );
}

export function resolveDeployDockerfile(ctx: RunContext, dir: string): string {
  const flag = ctx.flags.dockerfile
    ? String(ctx.flags.dockerfile)
    : 'Dockerfile';
  const absDir = path.resolve(dir);
  const abs = ctx.flags.dockerfile
    ? existsSyncFs(path.resolve(flag))
      ? path.resolve(flag)
      : path.resolve(absDir, flag)
    : path.resolve(absDir, flag);
  const rel = path.relative(absDir, abs).split(path.sep).join('/');
  if (!rel) throw usageError(`--dockerfile must be a file inside ${dir}`);
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel))
    throw usageError(`--dockerfile must be inside ${dir}`);
  return rel;
}

function existsSyncFs(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

register({
  path: ['servers', 'deployments', 'list'],
  summary: 'List deployments',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:read',
  aliases: ['ls'],
  examples: ['bitqate servers deployments list api'],
  async run(ctx) {
    const { id } = await resolveSrv(ctx);
    const resp = await ctx.api().get(['servers', id, 'deployments']);
    const data = resp?.deployments ?? [];
    return {
      data,
      render: (rows: any[], ui) => ({
        table: {
          columns: [
            { title: 'ID' },
            { title: 'Status', priority: 8 },
            { title: 'Branch', priority: 4 },
            { title: 'Commit', priority: 3 },
            { title: 'Triggered', priority: 2 },
            { title: 'Created', priority: 6 },
          ],
          rows: rows.map((d: any) => [
            shortId(d.id ?? ''),
            statusText(ui.theme, d.status ?? ''),
            d.branch ?? '',
            (d.commit_sha ?? '').slice(0, 8),
            d.triggered_by ?? '',
            relTime(d.created_at),
          ]),
          footer: rows.length ? undefined : 'No deployments yet.',
        },
      }),
    };
  },
});

register({
  path: ['servers', 'deployments', 'get'],
  summary: 'Show a deployment',
  args: [
    { name: 'id', required: false, description: 'Server name or ID' },
    { name: 'deployId', required: true, description: 'Deployment ID' },
  ],
  flags: {},
  scope: 'servers:read',
  aliases: ['show', 'info'],
  examples: ['bitqate servers deployments get api dep_1'],
  async run(ctx) {
    const { id } = await resolveSrv(ctx);
    const resp = await ctx
      .api()
      .get(['servers', id, 'deployments', ctx.args[1]]);
    const data = resp?.deployment ?? {};
    return {
      data,
      render: (d: any, ui) => ({
        detail: {
          title: `${d.id ?? ''}  ${statusText(ui.theme, d.status ?? '')}`,
          fields: [
            ['Status', d.status],
            ['Branch', d.branch],
            ['Commit', d.commit_sha],
            ['Triggered by', d.triggered_by],
            ['Created', relTime(d.created_at)],
            ['Finished', relTime(d.finished_at)],
          ],
        },
      }),
    };
  },
});

register({
  path: ['servers', 'deployments', 'logs'],
  summary: 'Print build logs',
  args: [
    { name: 'id', required: false, description: 'Server name or ID' },
    { name: 'deployId', required: true, description: 'Deployment ID' },
  ],
  flags: {},
  scope: 'servers:read',
  examples: ['bitqate servers deployments logs api dep_1'],
  async run(ctx) {
    const { id } = await resolveSrv(ctx);
    const resp = await ctx
      .api()
      .get(['servers', id, 'deployments', ctx.args[1], 'logs']);
    const data = resp ?? {};
    return { data, render: (d) => ({ lines: d.lines ?? [] }) };
  },
});

register({
  path: ['servers', 'wait'],
  summary: 'Wait for a status',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
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
  scope: 'servers:read',
  examples: ['bitqate servers wait api --status online'],
  async run(ctx) {
    const resolved = await resolveSrv(ctx);
    const server = await waitForServerStatus(
      ctx,
      resolved,
      new Set([ctx.flags.status]),
      'Waiting for',
    );
    return {
      data: server,
      render: (v) => ({ lines: [`${v.name ?? v.id} is ${v.status}`] }),
    };
  },
});

register({
  path: ['servers', 'open'],
  summary: 'Open a server in the dashboard',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:read',
  examples: ['bitqate servers open api'],
  async run(ctx) {
    const { id } = await resolveSrv(ctx);
    const url = portalUrl('server', id);
    if (!ctx.io.json && ctx.io.interactive) await openUrl(url);
    return { data: { url }, render: (d) => ({ lines: [`Opening ${d.url}`] }) };
  },
});
