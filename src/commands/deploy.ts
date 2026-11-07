import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, usageError } from '../core/errors';
import { ensureDockerfile } from '../core/dockerfile';
import { isRenderable, sanitize, type Renderable } from '../core/output';
import { resolveResource } from '../core/resolve';
import {
  findCommand,
  register,
  type CommandResult,
  type RunContext,
} from '../registry';
import { select } from '../ui/prompts';
import { task } from '../ui/spinner';
import { pickSource, type PickedSource } from '../wizards/server';
import { resolveDeployDockerfile } from './servers';

const LINK_FILE = '.bitqate.json';

interface Link {
  id: string;
  name: string;
}

function readLink(dir: string): Link | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, LINK_FILE), 'utf8'));
    const s = raw?.server;
    if (s && typeof s.id === 'string' && /^[0-9a-f-]{36}$/i.test(s.id))
      return { id: s.id, name: typeof s.name === 'string' ? s.name : s.id };
  } catch {}
  return null;
}

function writeLink(dir: string, link: Link): boolean {
  try {
    writeFileSync(
      path.join(dir, LINK_FILE),
      `${JSON.stringify({ server: { id: link.id, name: link.name } }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

function bareHost(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0];
}

async function liveAddress(
  ctx: RunContext,
  id: string,
): Promise<string | null> {
  try {
    const resp = await ctx.api().get(['servers', id]);
    const a = resp?.server?.address;
    if (a?.host && a?.port) return `${bareHost(String(a.host))}:${a.port}`;
  } catch {}
  return null;
}

function withExtras(
  result: CommandResult,
  extra: (ui: RunContext['io']) => string[],
  data: Record<string, unknown>,
): CommandResult {
  return {
    data: { ...(result.data ?? {}), ...data },
    render: (_d, ui) => {
      const base = result.render ? result.render(result.data, ui) : null;
      const lines =
        base && isRenderable(base) && 'lines' in base ? [...base.lines] : [];
      return { lines: [...lines, ...extra(ui)] } satisfies Renderable;
    },
  };
}

async function chooseTarget(
  ctx: RunContext,
): Promise<{ id: string; name: string } | null> {
  const resp = await task('Loading your servers', ctx.io.theme, () =>
    ctx.api().get(['servers']),
  );
  const servers: any[] = (resp?.servers ?? []).filter(
    (s: any) => s.kind === 'git',
  );
  if (!servers.length) return null;
  const picked = await select<string>(
    {
      message: 'Deploy to',
      options: [
        { label: 'A new server', value: '', hint: 'set it up now' },
        ...servers.map((s) => ({
          label: s.name ?? s.id,
          value: s.id,
          hint: [s.region?.name, s.status].filter(Boolean).join(' · '),
        })),
      ],
    },
    ctx.io.theme,
  );
  if (!picked) return null;
  const s = servers.find((x) => x.id === picked);
  return { id: picked, name: s?.name ?? picked };
}

register({
  path: ['deploy'],
  summary: 'Deploy your code, an app, a database or a game server',
  description:
    'Run it in your project folder. The first time it asks where to deploy and remembers the answer in .bitqate.json, so next time it just ships your latest code and streams the build.',
  args: [
    {
      name: 'path',
      required: false,
      description: 'Folder to deploy (default: the current folder)',
    },
  ],
  flags: {
    server: {
      type: 'string',
      placeholder: 'name',
      description: 'Deploy to this existing server',
    },
    new: { type: 'boolean', description: 'Always create a new server' },
    image: {
      type: 'string',
      placeholder: 'image',
      description: 'Deploy a Docker image instead of local code',
    },
    database: {
      type: 'string',
      placeholder: 'engine',
      description: 'Deploy a database: postgres, mysql, mongo or redis',
    },
    game: {
      type: 'string',
      placeholder: 'name',
      description: 'Deploy a game server from the catalog',
    },
    name: {
      type: 'string',
      placeholder: 'name',
      description: 'Name for a new server',
    },
    region: {
      type: 'string',
      placeholder: 'region',
      description: 'Region for a new server',
    },
    'memory-mb': {
      type: 'string',
      placeholder: 'mb',
      description: 'Memory in MB for a new server',
    },
    cpus: {
      type: 'string',
      placeholder: 'n',
      description: 'CPU cores for a new server',
    },
    'disk-gb': {
      type: 'string',
      placeholder: 'gb',
      description: 'Disk in GB for a new server',
    },
    env: {
      type: 'string',
      placeholder: 'KEY=VALUE',
      multiple: true,
      description: 'Environment variable for a new server',
    },
    workspace: {
      type: 'string',
      placeholder: 'workspace',
      description: 'Workspace to bill a new server to',
    },
    dockerfile: {
      type: 'string',
      placeholder: 'path',
      description: 'Dockerfile inside the folder (default: Dockerfile)',
    },
    message: {
      type: 'string',
      short: 'm',
      placeholder: 'text',
      description: 'Deployment message',
    },
    'no-follow': {
      type: 'boolean',
      description: "Don't stream the build logs",
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
  examples: [
    'bitqate deploy',
    'bitqate deploy ./api --server api',
    'bitqate deploy --database postgres',
    'bitqate deploy --image nginx:stable-alpine --name web',
    'bitqate deploy --game paper',
  ],
  async run(ctx) {
    const create = findCommand(['servers', 'create'])!;
    const upload = findCommand(['servers', 'deploy'])!;
    const tty = ctx.io.interactive && !ctx.io.json;
    const follow = !ctx.flags['no-follow'];
    const picked = [ctx.flags.image, ctx.flags.database, ctx.flags.game].filter(
      Boolean,
    );
    if (picked.length > 1)
      throw usageError('Pass only one of --image, --database or --game');
    if (picked.length && ctx.args[0])
      throw usageError(
        'A folder cannot be combined with --image, --database or --game',
      );

    if (picked.length)
      return create.run({
        ...ctx,
        args: [],
        flags: { ...ctx.flags, wait: true },
      });

    let dir: string | undefined = ctx.args[0];
    let link = readLink(dir ?? '.');
    let source: PickedSource | undefined;

    if (dir === undefined && !link && !ctx.flags.server && tty) {
      source = await pickSource(ctx);
      if (source.dir === undefined)
        return create.run({
          ...ctx,
          args: [],
          flags: { ...ctx.flags, wait: true, __source: source },
        });
      dir = source.dir;
      link = readLink(dir);
    }
    dir ??= '.';

    let st;
    try {
      st = statSync(dir);
    } catch {
      throw usageError(`No such folder: ${dir}`);
    }
    if (!st.isDirectory()) throw usageError(`Not a folder: ${dir}`);

    await ensureDockerfile(ctx, dir, resolveDeployDockerfile(ctx, dir));

    let target: { id: string; name: string } | null = null;
    if (ctx.flags.server) {
      target = await resolveResource(
        ctx,
        'servers',
        String(ctx.flags.server),
        ctx.io.theme,
      );
    } else if (link && !ctx.flags.new) {
      try {
        const resp = await ctx.api().get(['servers', link.id]);
        target = { id: link.id, name: resp?.server?.name ?? link.name };
        if (tty)
          process.stderr.write(
            `${ctx.io.theme.paint('muted', `Deploying ${sanitize(dir === '.' ? 'this folder' : dir)} to ${sanitize(target.name)} (from ${LINK_FILE})`)}\n`,
          );
      } catch (err) {
        if (!(err instanceof CliError && err.code === 'not_found')) throw err;
        if (tty)
          process.stderr.write(
            `${ctx.io.theme.paint('warning', ctx.io.theme.glyph('bang'))} The server in ${LINK_FILE} no longer exists. Pick another.\n`,
          );
      }
    }
    if (!target && !ctx.flags.new && tty) target = await chooseTarget(ctx);

    if (!target) {
      if (!tty && !(ctx.flags.region && ctx.flags.name))
        throw new CliError('usage', 'Nothing to deploy to yet.', {
          hint: `Pass --server <name>, or --new --name <name> --region <region> --memory-mb <mb> --cpus <n> --disk-gb <gb>`,
        });
      const result = await create.run({
        ...ctx,
        args: [],
        flags: {
          ...ctx.flags,
          dir,
          wait: follow,
          __source: source ?? (await pickSource({ ...ctx, flags: { dir } })),
        },
      });
      const id = String(result.data?.id ?? '');
      const name = String(result.data?.name ?? id);
      const saved = id ? writeLink(dir, { id, name }) : false;
      const address = id && follow ? await liveAddress(ctx, id) : null;
      return withExtras(
        result,
        (ui) => [
          ...(address
            ? [`  ${ui.theme.paint('muted', 'Address')}  ${address}`]
            : []),
          ...(saved
            ? [
                ui.theme.paint(
                  'muted',
                  `  Saved ${LINK_FILE}. Next time just run bitqate deploy.`,
                ),
              ]
            : []),
        ],
        { address, linked: saved },
      );
    }

    const result = await upload.run({
      ...ctx,
      args: [target.id],
      flags: { ...ctx.flags, dir, follow },
    });
    const saved =
      !link || link.id !== target.id ? writeLink(dir, target) : false;
    const address = follow ? await liveAddress(ctx, target.id) : null;
    return withExtras(
      result,
      (ui) => [
        ...(address
          ? [`  ${ui.theme.paint('muted', 'Address')}  ${address}`]
          : []),
        ...(saved
          ? [
              ui.theme.paint(
                'muted',
                `  Saved ${LINK_FILE}. Next time just run bitqate deploy.`,
              ),
            ]
          : []),
        ...(follow
          ? []
          : [
              ui.theme.paint(
                'muted',
                `  Watch the build with: bitqate servers logs ${/\s/.test(target!.name) ? `"${target!.name}"` : target!.name} --follow`,
              ),
            ]),
      ],
      { address, linked: saved || !!link },
    );
  },
});
