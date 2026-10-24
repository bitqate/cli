import { readFileSync } from 'node:fs';
import { CliError, usageError } from '../core/errors';
import { kvLines, sanitize } from '../core/output';
import { pollUntil } from '../core/poll';
import { cpusToUnits, parseEnvPairs, positiveInt } from '../core/validate';
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

const SERVER_FAIL = new Set(['suspended']);

async function waitForServerStatus(
  ctx: RunContext,
  id: string,
  targets: Set<string>,
  label: string,
) {
  return pollUntil(
    async () => {
      const resp = await ctx.api().get(['servers', id]);
      const server = resp?.server;
      if (!server) return null;
      if (targets.has(server.status)) return server;
      if (SERVER_FAIL.has(server.status))
        throw new CliError('server', `Server entered state '${server.status}'`);
      return null;
    },
    { timeoutMs: waitTimeoutMs(ctx), label },
  );
}

async function waitForInstall(ctx: RunContext, id: string, label: string) {
  return pollUntil(
    async () => {
      const resp = await ctx.api().get(['servers', id, 'install-state']);
      const state = resp?.installState;
      if (state === 'installed') return { id, installState: state };
      if (state === 'failed')
        throw new CliError('server', 'Server installation failed');
      return null;
    },
    { timeoutMs: waitTimeoutMs(ctx), label },
  );
}

function serverTable(rows: any[]) {
  return {
    table: {
      head: [
        'ID',
        'NAME',
        'STATUS',
        'KIND',
        'ADDRESS',
        'MEM MB',
        'CPU',
        'DISK GB',
      ],
      rows: rows.map((s) => [
        s.id ?? '',
        s.name ?? '',
        s.status ?? '',
        s.kind ?? '',
        s.address ? `${s.address.host}:${s.address.port}` : '',
        String(s.resources?.memory_mb ?? ''),
        String(s.resources?.cpu_cores ?? ''),
        String(s.resources?.disk_gb ?? ''),
      ]),
    },
  };
}

register({
  path: ['servers', 'list'],
  summary: 'List your servers',
  args: [],
  flags: {},
  scope: 'servers:read',
  examples: ['bitqate servers list', 'bitqate servers list -q'],
  async run(ctx) {
    const resp = await ctx.api().get(['servers']);
    const data = resp?.servers ?? [];
    return { data, render: (rows: any[]) => serverTable(rows) };
  },
});

register({
  path: ['servers', 'get'],
  summary: 'Show one server',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {},
  scope: 'servers:read',
  examples: ['bitqate servers get srv_abc123'],
  async run(ctx) {
    const resp = await ctx.api().get(['servers', ctx.args[0]]);
    const data = resp?.server ?? {};
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['servers', 'regions'],
  summary: 'List regions (daemons) where servers can run',
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
          head: ['ID', 'NAME', 'LOCATION'],
          rows: rows.map((d) => [d.id ?? '', d.name ?? '', d.location ?? '']),
        },
      }),
    };
  },
});

register({
  path: ['servers', 'create'],
  summary: 'Create a server (charges your balance)',
  args: [],
  flags: {
    name: { type: 'string', required: true, description: 'Server name' },
    region: {
      type: 'string',
      required: true,
      description: 'Daemon/region ID (see servers regions)',
    },
    'memory-mb': {
      type: 'string',
      required: true,
      description: 'Memory in MB',
    },
    cpus: {
      type: 'string',
      required: true,
      description: 'CPU cores (e.g. 1.5)',
    },
    'disk-gb': { type: 'string', required: true, description: 'Disk in GB' },
    image: { type: 'string', description: 'Container image reference' },
    'egg-url': { type: 'string', description: 'Game egg URL' },
    dockerfile: {
      type: 'string',
      description: 'Path to a Dockerfile (max 64 KB)',
    },
    git: {
      type: 'boolean',
      description: 'Build from a git repo connected in the dashboard',
    },
    env: {
      type: 'string',
      multiple: true,
      description: 'Environment variable KEY=VALUE (repeatable)',
    },
    startup: { type: 'string', description: 'Startup command' },
    workspace: { type: 'string', description: 'Workspace (team) ID' },
    ...waitFlag,
  },
  scope: 'servers:write',
  examples: [
    'bitqate servers create --name api --region fra-1 --memory-mb 1024 --cpus 1 --disk-gb 10 --image ghcr.io/org/app:latest',
    'bitqate servers create --name game --region fra-1 --memory-mb 4096 --cpus 2 --disk-gb 30 --egg-url https://... --env EULA=true',
  ],
  async run(ctx) {
    const sources = [
      ctx.flags.image,
      ctx.flags['egg-url'],
      ctx.flags.dockerfile,
      ctx.flags.git,
    ].filter((v) => v !== undefined && v !== false);
    if (sources.length !== 1)
      throw usageError(
        'Pass exactly one of --image, --egg-url, --dockerfile or --git',
      );

    const body: Record<string, unknown> = {
      name: ctx.flags.name,
      daemonId: ctx.flags.region,
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
    } else if (ctx.flags.dockerfile) {
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
    if (ctx.flags.env?.length) body.variables = parseEnvPairs(ctx.flags.env);
    if (ctx.flags.startup) body.startup = ctx.flags.startup;
    if (ctx.flags.workspace) body.teamId = ctx.flags.workspace;

    const resp = await ctx.api().post(['servers'], body);
    const id = resp?.id;
    const data: Record<string, unknown> = { id, mode: body.mode };
    if (body.mode === 'git')
      data.hint =
        'Connect the git repository for this server in the dashboard; repo connection is not exposed to API keys.';
    if (ctx.flags.wait && id && body.mode === 'egg')
      await waitForInstall(ctx, id, 'server installation');
    return {
      data,
      render: (d) => ({
        lines: [
          `Created server ${d.id ?? ''}`.trimEnd(),
          ...(d.hint ? [d.hint as string] : []),
        ],
      }),
    };
  },
});

for (const op of ['start', 'stop', 'restart'] as const) {
  register({
    path: ['servers', op],
    summary: `${op[0].toUpperCase() + op.slice(1)} a server`,
    args: [{ name: 'id', required: true, description: 'Server ID' }],
    flags: { ...waitFlag },
    scope: 'servers:power',
    examples: [`bitqate servers ${op} srv_abc123 --wait`],
    async run(ctx) {
      const resp = await ctx.api().post(['servers', ctx.args[0], op]);
      if (!ctx.flags.wait) {
        const data = { id: ctx.args[0], status: resp?.status ?? '' };
        return { data, render: (d) => ({ lines: kvLines(d) }) };
      }
      const targets =
        op === 'stop' ? new Set(['offline']) : new Set(['online']);
      const server = await waitForServerStatus(
        ctx,
        ctx.args[0],
        targets,
        `server ${op}`,
      );
      return { data: server, render: (d) => ({ lines: kvLines(d) }) };
    },
  });
}

register({
  path: ['servers', 'reinstall'],
  summary: 'Reinstall a server (destroys its files)',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {
    image: { type: 'string', description: 'New image reference' },
    'egg-url': { type: 'string', description: 'New egg URL' },
  },
  scope: 'servers:delete',
  destructive: true,
  examples: ['bitqate servers reinstall srv_abc123 --image nginx:latest --yes'],
  async run(ctx) {
    if (ctx.flags.image && ctx.flags['egg-url'])
      throw usageError('Pass only one of --image or --egg-url');
    const body: Record<string, unknown> = {};
    if (ctx.flags.image) body.image = ctx.flags.image;
    if (ctx.flags['egg-url']) body.eggUrl = ctx.flags['egg-url'];
    const resp = await ctx
      .api()
      .post(['servers', ctx.args[0], 'reinstall'], body);
    const data = { id: ctx.args[0], message: resp?.message ?? '' };
    return { data, render: (d) => ({ lines: [d.message] }) };
  },
});

register({
  path: ['servers', 'renew'],
  summary: 'Renew a server for 30 days (charges your balance)',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {},
  scope: 'servers:write',
  examples: ['bitqate servers renew srv_abc123'],
  async run(ctx) {
    const resp = await ctx.api().post(['servers', ctx.args[0], 'renew']);
    const data = { id: ctx.args[0], message: resp?.message ?? '' };
    return { data, render: (d) => ({ lines: [d.message] }) };
  },
});

register({
  path: ['servers', 'auto-renew'],
  summary: 'Enable or disable server auto-renewal',
  args: [
    { name: 'id', required: true, description: 'Server ID' },
    { name: 'state', required: true, description: 'on or off' },
  ],
  flags: {},
  scope: 'servers:write',
  examples: ['bitqate servers auto-renew srv_abc123 on'],
  async run(ctx) {
    const state = ctx.args[1];
    if (state !== 'on' && state !== 'off')
      throw usageError("Expected 'on' or 'off'");
    const resp = await ctx.api().put(['servers', ctx.args[0], 'auto-renew'], {
      auto_renew: state === 'on',
    });
    const data = {
      id: ctx.args[0],
      auto_renew: resp?.auto_renew ?? state === 'on',
      message: resp?.message,
    };
    return { data, render: (d) => ({ lines: [d.message ?? ''] }) };
  },
});

register({
  path: ['servers', 'rename'],
  summary: 'Rename a server',
  args: [
    { name: 'id', required: true, description: 'Server ID' },
    { name: 'name', required: true, description: 'New name' },
  ],
  flags: {},
  scope: 'servers:write',
  examples: ['bitqate servers rename srv_abc123 api-2'],
  async run(ctx) {
    const resp = await ctx.api().put(['servers', ctx.args[0], 'name'], {
      name: ctx.args[1],
    });
    const data = { id: ctx.args[0], name: resp?.name ?? ctx.args[1] };
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['servers', 'resize'],
  summary: 'Resize a server (charges your balance)',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {
    'memory-mb': { type: 'string', description: 'Memory in MB' },
    cpus: { type: 'string', description: 'CPU cores (e.g. 1.5)' },
    'disk-gb': { type: 'string', description: 'Disk in GB' },
  },
  scope: 'servers:write',
  examples: ['bitqate servers resize srv_abc123 --memory-mb 2048 --cpus 2'],
  async run(ctx) {
    const body: Record<string, unknown> = {};
    if (ctx.flags['memory-mb'] !== undefined)
      body.ram = positiveInt(ctx.flags['memory-mb'], 'memory-mb');
    if (ctx.flags.cpus !== undefined)
      body.cpu = cpusToUnits(ctx.flags.cpus, 'cpus');
    if (ctx.flags['disk-gb'] !== undefined)
      body.disk = positiveInt(ctx.flags['disk-gb'], 'disk-gb');
    if (!Object.keys(body).length)
      throw usageError('Pass at least one of --memory-mb, --cpus or --disk-gb');
    const resp = await ctx
      .api()
      .patch(['servers', ctx.args[0], 'resize'], body);
    const data = {
      ...(resp?.server ?? {}),
      charged: resp?.charged,
      newMonthlyCost: resp?.newMonthlyCost,
    };
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['servers', 'ports'],
  summary: 'Set extra ports for a server (replaces the whole list)',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {
    port: {
      type: 'string',
      multiple: true,
      description: 'internalPort[:tcp|udp], repeatable; omit all to clear',
    },
  },
  scope: 'servers:write',
  examples: [
    'bitqate servers ports srv_abc123 --port 25566:udp --port 8080',
    'bitqate servers ports srv_abc123',
  ],
  async run(ctx) {
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
    const resp = await ctx.api().put(['servers', ctx.args[0], 'ports'], {
      ports,
    });
    const data = {
      id: ctx.args[0],
      ports: resp?.ports ?? [],
      limit: resp?.limit,
      message: resp?.message,
    };
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['servers', 'startup'],
  summary: 'Set the startup command and environment of a server',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {
    command: { type: 'string', description: 'Startup command' },
    env: {
      type: 'string',
      multiple: true,
      description: 'Environment variable KEY=VALUE (repeatable)',
    },
  },
  scope: 'servers:write',
  examples: [
    'bitqate servers startup srv_abc123 --command "./run.sh" --env MODE=prod',
  ],
  async run(ctx) {
    const body: Record<string, unknown> = {};
    if (ctx.flags.command !== undefined) body.startup = ctx.flags.command;
    if (ctx.flags.env?.length) body.variables = parseEnvPairs(ctx.flags.env);
    if (!Object.keys(body).length) throw usageError('Pass --command or --env');
    const resp = await ctx.api().put(['servers', ctx.args[0], 'startup'], body);
    const data = {
      id: ctx.args[0],
      startup: resp?.startup,
      variables: resp?.variables,
    };
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['servers', 'install-state'],
  summary: 'Show the install state of a server',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {},
  scope: 'servers:read',
  examples: ['bitqate servers install-state srv_abc123'],
  async run(ctx) {
    const resp = await ctx.api().get(['servers', ctx.args[0], 'install-state']);
    const data = { id: ctx.args[0], installState: resp?.installState };
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['servers', 'delete'],
  summary: 'Delete a server permanently',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {},
  scope: 'servers:delete',
  destructive: true,
  confirmInside: true,
  examples: ['bitqate servers delete srv_abc123 --yes'],
  async run(ctx) {
    const preview = await ctx
      .api()
      .get(['servers', ctx.args[0], 'delete-preview']);
    if (!ctx.io.yes) {
      if (ctx.io.json || !process.stdin.isTTY)
        throw new CliError('usage', 'Deleting is destructive.', {
          hint: 'pass --yes to confirm',
        });
      process.stderr.write(
        `Server ${sanitize(ctx.args[0])}: refund ${preview?.refund ?? 0}, backups ${preview?.backups?.count ?? 0} (${preview?.backups?.size_bytes ?? 0} bytes)\n`,
      );
      const { confirmResourceId } = await import('../core/prompt');
      if (!(await confirmResourceId(ctx.args[0])))
        throw usageError('Confirmation did not match; aborted.');
    }
    const resp = await ctx.api().delete(['servers', ctx.args[0]]);
    const data = {
      id: ctx.args[0],
      preview,
      refunded: resp?.refunded,
      message: resp?.message,
    };
    return { data, render: (d) => ({ lines: [d.message ?? ''] }) };
  },
});

register({
  path: ['servers', 'backups', 'list'],
  summary: 'List backups of a server',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {},
  scope: 'servers:read',
  examples: ['bitqate servers backups list srv_abc123'],
  async run(ctx) {
    const resp = await ctx.api().get(['servers', ctx.args[0], 'backups']);
    const data = resp?.backups ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          head: ['ID', 'STATUS', 'SIZE', 'CREATED'],
          rows: rows.map((b) => [
            b.id ?? '',
            b.status ?? '',
            b.size_bytes != null ? String(b.size_bytes) : '',
            b.created_at ?? '',
          ]),
        },
      }),
    };
  },
});

register({
  path: ['servers', 'backups', 'create'],
  summary: 'Create a server backup',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {},
  scope: 'servers:write',
  examples: ['bitqate servers backups create srv_abc123'],
  async run(ctx) {
    const resp = await ctx.api().post(['servers', ctx.args[0], 'backups']);
    const data = resp?.backup ?? {};
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['servers', 'backups', 'restore'],
  summary: 'Restore a server backup (overwrites server files)',
  args: [
    { name: 'id', required: true, description: 'Server ID' },
    { name: 'backupId', required: true, description: 'Backup ID' },
  ],
  flags: {},
  scope: 'servers:delete',
  destructive: true,
  examples: ['bitqate servers backups restore srv_abc123 bak_1 --yes'],
  async run(ctx) {
    const resp = await ctx
      .api()
      .post(['servers', ctx.args[0], 'backups', ctx.args[1], 'restore']);
    return {
      data: { id: ctx.args[0], backupId: ctx.args[1], restored: true },
      render: () => ({ lines: ['Backup restore started.'] }),
    };
  },
});

register({
  path: ['servers', 'backups', 'delete'],
  summary: 'Delete a server backup permanently',
  args: [
    { name: 'id', required: true, description: 'Server ID' },
    { name: 'backupId', required: true, description: 'Backup ID' },
  ],
  flags: {},
  scope: 'servers:delete',
  destructive: true,
  examples: ['bitqate servers backups delete srv_abc123 bak_1 --yes'],
  async run(ctx) {
    await ctx.api().delete(['servers', ctx.args[0], 'backups', ctx.args[1]]);
    return {
      data: { id: ctx.args[0], backupId: ctx.args[1], deleted: true },
      render: () => ({ lines: ['Backup deleted.'] }),
    };
  },
});

register({
  path: ['servers', 'deploy'],
  summary: 'Trigger a git deployment',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {
    follow: {
      type: 'boolean',
      description: 'Stream deployment logs until it finishes',
    },
  },
  scope: 'servers:write',
  examples: ['bitqate servers deploy srv_abc123 --follow'],
  async run(ctx) {
    const resp = await ctx.api().post(['servers', ctx.args[0], 'deploy'], {});
    const deploymentId = resp?.deploymentId;
    if (!ctx.flags.follow || !deploymentId) {
      const data = { id: ctx.args[0], deploymentId, status: resp?.status };
      return { data, render: (d) => ({ lines: kvLines(d) }) };
    }
    let printed = 0;
    const dep = await pollUntil(
      async () => {
        const logs = await ctx
          .api()
          .get(['servers', ctx.args[0], 'deployments', deploymentId, 'logs']);
        const lines: string[] = logs?.lines ?? [];
        const sink = ctx.io.json ? process.stderr : process.stdout;
        for (; printed < lines.length; printed++)
          sink.write(`${sanitize(lines[printed])}\n`);
        if (!logs?.done) return null;
        const detail = await ctx
          .api()
          .get(['servers', ctx.args[0], 'deployments', deploymentId]);
        return detail?.deployment ?? { status: 'unknown' };
      },
      { timeoutMs: waitTimeoutMs(ctx), label: 'deployment' },
    );
    if (dep.status === 'failed')
      throw new CliError('server', 'Deployment failed');
    const data = { id: ctx.args[0], deploymentId, status: dep.status };
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['servers', 'deployments', 'list'],
  summary: 'List deployments of a server',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {},
  scope: 'servers:read',
  examples: ['bitqate servers deployments list srv_abc123'],
  async run(ctx) {
    const resp = await ctx.api().get(['servers', ctx.args[0], 'deployments']);
    const data = resp?.deployments ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          head: ['ID', 'STATUS', 'BRANCH', 'COMMIT', 'TRIGGERED BY', 'CREATED'],
          rows: rows.map((d) => [
            d.id ?? '',
            d.status ?? '',
            d.branch ?? '',
            (d.commit_sha ?? '').slice(0, 8),
            d.triggered_by ?? '',
            d.created_at ?? '',
          ]),
        },
      }),
    };
  },
});

register({
  path: ['servers', 'deployments', 'get'],
  summary: 'Show one deployment',
  args: [
    { name: 'id', required: true, description: 'Server ID' },
    { name: 'deployId', required: true, description: 'Deployment ID' },
  ],
  flags: {},
  scope: 'servers:read',
  examples: ['bitqate servers deployments get srv_abc123 dep_1'],
  async run(ctx) {
    const resp = await ctx
      .api()
      .get(['servers', ctx.args[0], 'deployments', ctx.args[1]]);
    const data = resp?.deployment ?? {};
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['servers', 'deployments', 'logs'],
  summary: 'Print deployment build logs',
  args: [
    { name: 'id', required: true, description: 'Server ID' },
    { name: 'deployId', required: true, description: 'Deployment ID' },
  ],
  flags: {},
  scope: 'servers:read',
  examples: ['bitqate servers deployments logs srv_abc123 dep_1'],
  async run(ctx) {
    const resp = await ctx
      .api()
      .get(['servers', ctx.args[0], 'deployments', ctx.args[1], 'logs']);
    const data = resp ?? {};
    return {
      data,
      render: (d) => ({ lines: d.lines ?? [] }),
    };
  },
});

register({
  path: ['servers', 'wait'],
  summary: 'Wait for a server to reach a status',
  args: [{ name: 'id', required: true, description: 'Server ID' }],
  flags: {
    status: { type: 'string', required: true, description: 'Target status' },
    'wait-timeout': waitFlag['wait-timeout'],
  },
  scope: 'servers:read',
  examples: ['bitqate servers wait srv_abc123 --status online'],
  async run(ctx) {
    const server = await waitForServerStatus(
      ctx,
      ctx.args[0],
      new Set([ctx.flags.status]),
      `status ${ctx.flags.status}`,
    );
    return { data: server, render: (d) => ({ lines: kvLines(d) }) };
  },
});
