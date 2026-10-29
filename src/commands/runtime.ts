import { CliError, usageError } from '../core/errors';
import { followDeployment } from './deploy-follow';
import { waitPoll } from '../core/confirm';
import { resolveResource } from '../core/resolve';
import { sanitize } from '../core/output';
import { positiveInt } from '../core/validate';
import { relTime, shortId } from '../ui/format';
import { statusText } from '../ui/theme';
import { register, type RunContext } from '../registry';
import type { Renderable } from '../core/output';

// Runtime commands for container servers: logs, health checks, the private
// network and git deployment rollbacks.

function checkmark(ui: { theme: any }, msg: string): string {
  return `${ui.theme.paint('success', ui.theme.glyph('check'))} ${msg}`;
}

async function resolveSrv(ctx: RunContext) {
  return resolveResource(ctx, 'servers', ctx.args[0], ctx.io.theme);
}

function optionalInt(ctx: RunContext, flag: string): number | undefined {
  const v = ctx.flags[flag];
  return v === undefined ? undefined : positiveInt(String(v), flag);
}

// "10m", "2h", "1d", "90s" or anything Date can parse -> unix seconds.
export function parseSince(value: string, now = Date.now()): number {
  const m = /^(\d+)([smhd])$/.exec(value.trim());
  if (m) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[
      m[2] as 's' | 'm' | 'h' | 'd'
    ];
    return Math.floor(now / 1000) - Number(m[1]) * unit;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t))
    throw usageError(
      `Invalid --since "${value}": use a duration like 10m, 2h, 1d or a date`,
    );
  return Math.floor(t / 1000);
}

export interface LogEntry {
  t: string | null;
  line: string;
}

// Reads an NDJSON body line by line.
export async function* ndjson(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) {
        if (!part.trim()) continue;
        try {
          yield JSON.parse(part) as Record<string, any>;
        } catch {}
      }
    }
    pending += decoder.decode();
    if (pending.trim()) {
      try {
        yield JSON.parse(pending) as Record<string, any>;
      } catch {}
    }
  } finally {
    reader.releaseLock();
  }
}

function formatEntry(entry: LogEntry, timestamps: boolean, theme: any): string {
  const line = sanitize(entry.line);
  if (!timestamps || !entry.t) return line;
  const ts = entry.t.replace(/\.\d+Z$/, 'Z');
  return `${theme.paint('muted', ts)} ${line}`;
}

register({
  path: ['servers', 'logs'],
  summary: 'Print or follow a server’s output',
  description:
    'Prints what the container writes to stdout/stderr (the dashboard console). ' +
    'With --follow it keeps streaming, reconnecting across restarts, until Ctrl-C. ' +
    'With --json each line is a {"t","line"} object (NDJSON while following).',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {
    follow: {
      type: 'boolean',
      short: 'f',
      description: 'Keep streaming new output',
    },
    tail: {
      type: 'string',
      placeholder: 'n',
      description: 'Lines of history to start with (default 200, max 5000)',
    },
    since: {
      type: 'string',
      placeholder: 'when',
      description: 'Only output after this time (10m, 2h, 1d or a date)',
    },
    timestamps: {
      type: 'boolean',
      short: 't',
      description: 'Prefix each line with its time',
    },
  },
  scope: 'servers:read',
  examples: [
    'bitqate servers logs api',
    'bitqate servers logs api -f --tail 50',
    'bitqate servers logs api --since 1h --timestamps',
  ],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    const tailFlag = ctx.flags.tail;
    const tail =
      tailFlag === undefined
        ? 200
        : /^\d+$/.test(String(tailFlag))
          ? Number(tailFlag)
          : (() => {
              throw usageError('--tail must be a whole number');
            })();
    const since = ctx.flags.since
      ? parseSince(String(ctx.flags.since))
      : undefined;
    const timestamps = !!ctx.flags.timestamps;

    if (!ctx.flags.follow) {
      const resp = await ctx
        .api()
        .stream(['servers', id, 'logs'], { tail, since });
      const entries: LogEntry[] = [];
      for await (const obj of ndjson(resp.body as ReadableStream<Uint8Array>)) {
        if (typeof obj.line === 'string')
          entries.push({ t: obj.t ?? null, line: obj.line });
        else if (obj.event === 'error')
          throw new CliError(
            'server',
            String(obj.message ?? 'Could not read logs'),
          );
      }
      return {
        data: entries,
        render: (rows: LogEntry[], ui) => ({
          lines: rows.length
            ? rows.map((e) => formatEntry(e, timestamps, ui.theme))
            : [ui.theme.paint('muted', `No output from ${name} yet.`)],
        }),
      };
    }

    // Follow until Ctrl-C. The daemon ends the stream when the container
    // stops; reconnect from the last line seen so restarts and redeploys
    // don't end the session.
    const theme = ctx.io.theme;
    const note = (msg: string) => {
      if (!ctx.io.json) process.stderr.write(`${theme.paint('muted', msg)}\n`);
    };
    let lastT: string | null = null;
    let sinceSec = since;
    let firstTail = tail;
    for (;;) {
      let resp: Response | null = null;
      try {
        resp = await ctx.api().stream(['servers', id, 'logs'], {
          follow: 1,
          tail: firstTail,
          since: sinceSec,
        });
      } catch (err) {
        // No container right now (stopped, mid-redeploy): wait for one.
        if (!(err instanceof CliError) || err.exitCode !== 5) throw err;
      }
      if (resp?.body) {
        for await (const obj of ndjson(resp.body)) {
          if (typeof obj.line === 'string') {
            const entry: LogEntry = { t: obj.t ?? null, line: obj.line };
            // Reconnects resume at whole seconds; skip what was printed.
            if (lastT && entry.t && entry.t <= lastT) continue;
            if (entry.t) lastT = entry.t;
            process.stdout.write(
              ctx.io.json
                ? `${JSON.stringify(entry)}\n`
                : `${formatEntry(entry, timestamps, theme)}\n`,
            );
          } else if (obj.event === 'exit') {
            note(
              `— ${name} stopped; waiting for it to start again (Ctrl-C to quit)`,
            );
          } else if (obj.event === 'error') {
            note(`— log stream error: ${sanitize(String(obj.message ?? ''))}`);
          }
        }
      }
      if (lastT) sinceSec = Math.floor(Date.parse(lastT) / 1000);
      firstTail = lastT ? 5000 : 0;
      await new Promise((r) => setTimeout(r, 2000));
    }
  },
});

// ---------- health checks ----------

function healthLines(d: any, ui: any): Renderable {
  if (!d.healthCheck) {
    return {
      lines: [
        'No health check configured.',
        ui.theme.paint(
          'muted',
          'Add one with: bitqate servers health set <server> --path /healthz',
        ),
      ],
    };
  }
  const hc = d.healthCheck;
  return {
    detail: {
      title: `Health  ${statusText(ui.theme, d.status ?? 'unknown')}`,
      fields: [
        ['Check', hc.type === 'tcp' ? 'TCP connect' : `HTTP GET ${hc.path}`],
        ['Every', `${hc.intervalSec}s (timeout ${hc.timeoutSec}s)`],
        ['Unhealthy after', `${hc.failureThreshold} failures`],
        ['Grace period', `${hc.gracePeriodSec}s after start`],
        ['Auto-restart', hc.autoRestart ? 'on (max 3/hour)' : 'off'],
        ['Last checked', d.lastCheckedAt ? relTime(d.lastCheckedAt) : '—'],
        ['Last error', d.lastError ?? '—'],
        ['Restarts (1h)', String(d.restartsLastHour ?? 0)],
      ],
    },
  };
}

register({
  path: ['servers', 'health', 'get'],
  summary: 'Show the health check and its last result',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:read',
  aliases: ['show', 'info'],
  examples: ['bitqate servers health get api'],
  async run(ctx) {
    const { id } = await resolveSrv(ctx);
    const data = await ctx.api().get(['servers', id, 'health-check']);
    return { data, render: healthLines };
  },
});

register({
  path: ['servers', 'health', 'set'],
  summary: 'Configure the health check',
  description:
    'Git deploys only switch traffic once the check passes (and restore the ' +
    'previous version if it never does). A running server that keeps failing ' +
    'is restarted, at most 3 times an hour.',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {
    type: {
      type: 'string',
      placeholder: 'http|tcp',
      description: 'Check type (default http)',
    },
    path: {
      type: 'string',
      placeholder: 'path',
      description: 'HTTP path that must return 2xx/3xx (default /)',
    },
    interval: {
      type: 'string',
      placeholder: 'seconds',
      description: 'Seconds between checks (10-3600, default 30)',
    },
    timeout: {
      type: 'string',
      placeholder: 'seconds',
      description: 'Seconds per check (1-60, default 5)',
    },
    failures: {
      type: 'string',
      placeholder: 'n',
      description: 'Failures in a row before unhealthy (default 3)',
    },
    grace: {
      type: 'string',
      placeholder: 'seconds',
      description: 'Seconds after start before failures count (default 60)',
    },
    'no-restart': {
      type: 'boolean',
      description: 'Report only; never restart',
    },
  },
  scope: 'servers:write',
  examples: [
    'bitqate servers health set api --path /healthz',
    'bitqate servers health set db --type tcp --interval 60',
  ],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    const type = ctx.flags.type ?? 'http';
    if (type !== 'http' && type !== 'tcp')
      throw usageError('--type must be http or tcp');
    if (type === 'tcp' && ctx.flags.path)
      throw usageError('--path only applies to http checks');
    const healthCheck = {
      type,
      ...(type === 'http' ? { path: ctx.flags.path ?? '/' } : {}),
      intervalSec: optionalInt(ctx, 'interval'),
      timeoutSec: optionalInt(ctx, 'timeout'),
      failureThreshold: optionalInt(ctx, 'failures'),
      gracePeriodSec: ctx.flags.grace === '0' ? 0 : optionalInt(ctx, 'grace'),
      autoRestart: !ctx.flags['no-restart'],
    };
    const resp = await ctx
      .api()
      .put(['servers', id, 'health-check'], { healthCheck });
    const hc = resp?.healthCheck ?? healthCheck;
    return {
      data: { id, healthCheck: hc },
      render: (_d, ui) => ({
        lines: [
          checkmark(
            ui,
            `Health check for ${name}: ${hc.type === 'tcp' ? 'TCP connect' : `GET ${hc.path}`} every ${hc.intervalSec ?? 30}s`,
          ),
        ],
      }),
    };
  },
});

register({
  path: ['servers', 'health', 'clear'],
  summary: 'Remove the health check',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:write',
  aliases: ['rm'],
  examples: ['bitqate servers health clear api'],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    await ctx.api().put(['servers', id, 'health-check'], { healthCheck: null });
    return {
      data: { id, healthCheck: null },
      render: (_d, ui) => ({
        lines: [checkmark(ui, `Removed the health check from ${name}`)],
      }),
    };
  },
});

// ---------- private network ----------

function networkRender(d: any, ui: any): Renderable {
  if (!d.enabled) {
    return {
      lines: [
        'Not on the private network.',
        ui.theme.paint(
          'muted',
          `Join with: bitqate servers network enable <server> --hostname ${d.suggestedHostname ?? 'name'}`,
        ),
      ],
    };
  }
  const lines = [
    `${ui.theme.paint('strong', d.hostname)}${d.ip ? `  ${d.ip}` : ''}`,
  ];
  if (d.restartRequired)
    lines.push(
      ui.theme.paint('warning', 'Restart the server to join the network.'),
    );
  if (d.peers?.length) {
    lines.push('', 'Reachable from here:');
    for (const p of d.peers)
      lines.push(
        `  ${p.hostname}${p.ip ? `  ${p.ip}` : ''}  (${sanitize(p.name ?? p.id)})`,
      );
  } else {
    lines.push(
      '',
      ui.theme.paint(
        'muted',
        'No other servers of this workspace on this node have joined yet.',
      ),
    );
  }
  if (d.otherNodes?.length)
    lines.push(
      ui.theme.paint(
        'muted',
        `On other nodes (not reachable privately): ${d.otherNodes.map((o: any) => sanitize(o.name ?? o.id)).join(', ')}`,
      ),
    );
  return { lines };
}

register({
  path: ['servers', 'network', 'get'],
  summary: 'Show private network membership and peers',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:read',
  aliases: ['show', 'info'],
  examples: ['bitqate servers network get api'],
  async run(ctx) {
    const { id } = await resolveSrv(ctx);
    const data = await ctx.api().get(['servers', id, 'private-network']);
    return { data, render: networkRender };
  },
});

register({
  path: ['servers', 'network', 'enable'],
  summary: 'Join the workspace private network',
  description:
    'Servers of one workspace on the same node reach each other at ' +
    '<hostname>.internal without going over the public internet. ' +
    'Takes effect on the server’s next restart.',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {
    hostname: {
      type: 'string',
      placeholder: 'name',
      description: 'Name before .internal (default: from the server name)',
    },
  },
  scope: 'servers:write',
  examples: [
    'bitqate servers network enable db --hostname db',
    'bitqate servers network enable api',
  ],
  async run(ctx) {
    const { id } = await resolveSrv(ctx);
    const data = await ctx.api().put(['servers', id, 'private-network'], {
      enabled: true,
      ...(ctx.flags.hostname ? { hostname: ctx.flags.hostname } : {}),
    });
    return { data, render: networkRender };
  },
});

register({
  path: ['servers', 'network', 'disable'],
  summary: 'Leave the private network',
  args: [{ name: 'id', required: false, description: 'Server name or ID' }],
  flags: {},
  scope: 'servers:write',
  examples: ['bitqate servers network disable api'],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    await ctx.api().put(['servers', id, 'private-network'], { enabled: false });
    return {
      data: { id, enabled: false },
      render: (_d, ui) => ({
        lines: [
          checkmark(ui, `${name} left the private network`),
          ui.theme.paint(
            'muted',
            'Its address is released after its next restart.',
          ),
        ],
      }),
    };
  },
});

// ---------- rollback ----------

// Without an explicit deployment: the newest successful one older than the
// newest successful one, i.e. the version before the one that's live.
export function pickRollbackTarget(deployments: any[]): any | null {
  const ok = deployments
    .filter((d) => d.status === 'success')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return (
    ok
      .slice(1)
      .find(
        (d) =>
          d.triggered_by !== 'upload' &&
          /^[0-9a-f]{40}$/i.test(d.commit_sha ?? ''),
      ) ?? null
  );
}

register({
  path: ['servers', 'deployments', 'rollback'],
  summary: 'Redeploy the commit of an earlier deployment',
  description:
    'Rebuilds the exact commit of an earlier successful deployment with the ' +
    'server’s current env vars. Without a deployment ID it picks the version ' +
    'before the live one. The next push still deploys as usual.',
  args: [
    { name: 'id', required: false, description: 'Server name or ID' },
    {
      name: 'deployId',
      required: false,
      description: 'Deployment ID (default: previous version)',
    },
  ],
  flags: {
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
  examples: [
    'bitqate servers deployments rollback api --follow',
    'bitqate servers deployments rollback api 3f2a9c1e',
  ],
  async run(ctx) {
    const { id, name } = await resolveSrv(ctx);
    const list =
      (await ctx.api().get(['servers', id, 'deployments']))?.deployments ?? [];
    let target: any;
    if (ctx.args[1]) {
      const ref = ctx.args[1];
      const matches = list.filter(
        (d: any) => d.id === ref || d.id.startsWith(ref),
      );
      if (matches.length !== 1)
        throw new CliError(
          matches.length ? 'usage' : 'not_found',
          matches.length
            ? `Deployment ID "${ref}" is ambiguous`
            : `No deployment "${ref}" among the last 20 for ${name}`,
        );
      target = matches[0];
      if (target.triggered_by === 'upload')
        throw new CliError(
          'usage',
          "Uploaded deployments can't be rolled back; deploy the code again with --dir.",
        );
    } else {
      target = pickRollbackTarget(list);
      if (!target)
        throw new CliError(
          'not_found',
          `${name} has no earlier successful deployment to roll back to`,
        );
    }

    const resp = await ctx
      .api()
      .post(['servers', id, 'deployments', target.id, 'rollback'], {});
    const deploymentId = resp?.deploymentId;
    const sha = String(target.commit_sha).slice(0, 8);
    if (!ctx.flags.follow || !deploymentId) {
      return {
        data: {
          id,
          deploymentId,
          rollbackOf: target.id,
          commitSha: target.commit_sha,
          status: resp?.status,
        },
        render: (_d, ui) => ({
          lines: [
            checkmark(
              ui,
              `Rolling ${name} back to ${sha} (deployment ${shortId(deploymentId ?? '')})`,
            ),
            ui.theme.paint(
              'muted',
              `Follow with: bitqate servers deployments logs ${name} ${deploymentId}`,
            ),
          ],
        }),
      };
    }

    const timeoutMs = ctx.flags['wait-timeout']
      ? positiveInt(String(ctx.flags['wait-timeout']), 'wait-timeout') * 1000
      : 600_000;
    const dep = await followDeployment(
      ctx,
      { id, name },
      deploymentId,
      timeoutMs,
    );
    if (dep.status === 'failed')
      throw new CliError('server', 'Rollback failed');
    return {
      data: {
        id,
        deploymentId,
        rollbackOf: target.id,
        commitSha: target.commit_sha,
        status: dep.status,
      },
      render: (_d, ui) => ({
        lines: [checkmark(ui, `${name} is back on ${sha}`)],
      }),
    };
  },
});
