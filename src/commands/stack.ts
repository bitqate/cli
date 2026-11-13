import path from 'path';
import type { RunContext } from '../registry';
import { CliError, usageError } from '../core/errors';
import { resolveOption } from '../core/resolve';
import { priceMap, serverMonthly } from '../core/pricing';
import { sanitize } from '../core/output';
import {
  STACK_CONFIG_FILE,
  checkInputKeys,
  generateSecrets,
  isDatabaseImage,
  missingInputs,
  parseInputFlags,
  readStackConfig,
  renderEnv,
  resolveInputs,
  stackHostname,
} from '../core/stack-config';
import type {
  RenderContext,
  StackConfig,
  StackService,
} from '../core/stack-config';
import { confirm, password, text } from '../ui/prompts';
import { task } from '../ui/spinner';
import { readComposeLink, writeComposeLink } from './compose';
import type { ComposeLink } from './compose';

type Kind = 'database' | 'image' | 'build';

function kindOf(s: StackService): Kind {
  if (s.dockerfile) return 'build';
  return s.image && isDatabaseImage(s.image) ? 'database' : 'image';
}

function sourceOf(s: StackService): string {
  return s.image ?? `build ${s.dockerfile}`;
}

function stackName(ctx: RunContext, dir: string): string {
  const raw = ctx.flags.name
    ? String(ctx.flags.name)
    : path.basename(path.resolve(dir));
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  if (!name) throw usageError('Pass --name for the stack');
  return name;
}

function sized(ctx: RunContext, s: StackService) {
  return {
    ram: ctx.flags['memory-mb']
      ? Number(ctx.flags['memory-mb'])
      : s.resources.ram,
    cpu: ctx.flags.cpus
      ? Math.round(Number(ctx.flags.cpus) * 100)
      : s.resources.cpu,
    disk: ctx.flags['disk-gb']
      ? Number(ctx.flags['disk-gb'])
      : s.resources.disk,
  };
}

async function promptInputs(
  ctx: RunContext,
  config: StackConfig,
  provided: Record<string, string>,
): Promise<Record<string, string>> {
  const missing = missingInputs(config, provided);
  if (!missing.length) return provided;
  if (!ctx.io.interactive || ctx.io.json) {
    throw usageError(
      `Missing inputs: ${missing.map((i) => `--input ${i.key}=...`).join(' ')}`,
    );
  }
  const out = { ...provided };
  for (const input of missing) {
    const message = input.description
      ? `${input.label} (${input.description})`
      : input.label;
    out[input.key] =
      input.type === 'password'
        ? await password({ message }, ctx.io.theme)
        : await text(
            {
              message,
              validate: (v) => (v.trim() ? null : `${input.label} is required`),
            },
            ctx.io.theme,
          );
  }
  return out;
}

async function packageService(ctx: RunContext, dir: string, s: StackService) {
  const { packageDir } = await import('./servers');
  return packageDir(
    {
      ...ctx,
      flags: {
        ...ctx.flags,
        dockerfile: path.join(dir, s.dockerfile ?? 'Dockerfile'),
      },
    },
    dir,
  );
}

async function redeploy(
  ctx: RunContext,
  dir: string,
  config: StackConfig,
  link: ComposeLink,
) {
  const { uploadPackage } = await import('./servers');
  const out: string[] = [];
  for (const s of config.services) {
    const cur = link.services[s.name];
    if (!cur) {
      out.push(
        `${s.name}: not deployed yet, remove .bitqate.json to deploy the stack again`,
      );
      continue;
    }
    if (!s.dockerfile) {
      out.push(`${s.name} (${kindOf(s)}): unchanged`);
      continue;
    }
    await uploadPackage(ctx, cur.id, await packageService(ctx, dir, s));
    out.push(`${s.name}: re-uploaded to ${cur.name}`);
  }
  for (const l of out) process.stderr.write(`${sanitize(l)}\n`);
  return {
    data: { ok: true, reUpload: true },
    render: () => ({ lines: out }),
  };
}

async function assignedPort(
  ctx: RunContext,
  id: string,
): Promise<number | null> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const info = await ctx.api().get(['servers', id]);
    const port = info?.server?.address?.port ?? info?.address?.port;
    if (port) return Number(port);
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function runStack(
  ctx: RunContext,
  dir: string,
): Promise<{ data: any; render: (d: any, ui: any) => any }> {
  const config = readStackConfig(dir);
  const link = readComposeLink(dir);
  if (link) return redeploy(ctx, dir, config, link);

  const name = stackName(ctx, dir);
  const isStack = config.services.length > 1;
  const provided = parseInputFlags(ctx.flags.input as string[] | undefined);
  checkInputKeys(config, provided);

  const region =
    ctx.flags['dry-run'] && ctx.flags.region
      ? String(ctx.flags.region)
      : String(
          await resolveOption(
            ctx,
            ['daemons'],
            ctx.flags.region,
            ['id', 'name', 'location'],
            'region',
          ),
        );

  let prices: ReturnType<typeof priceMap> | null = null;
  try {
    const p = await ctx.api().get(['prices']);
    prices = priceMap(p?.prices ?? []);
  } catch {}
  const monthly = (s: StackService) => {
    const r = sized(ctx, s);
    return prices
      ? serverMonthly(
          { ram_mb: r.ram, cpu_units: r.cpu, disk_gb: r.disk },
          prices,
        )
      : null;
  };
  const rows = config.services.map((s) => {
    const r = sized(ctx, s);
    const m = monthly(s);
    return [
      s.name,
      kindOf(s),
      sourceOf(s),
      `${r.ram}MB`,
      `${r.cpu / 100}`,
      `${r.disk}GB`,
      m === null ? 'prices need a login' : `$${m.toFixed(2)}/mo`,
    ];
  });
  const columns = [
    'service',
    'kind',
    'source',
    'ram',
    'cpu',
    'disk',
    'monthly',
  ];
  const total = config.services.reduce((t, s) => t + (monthly(s) ?? 0), 0);

  if (ctx.flags['dry-run']) {
    return {
      data: {
        plan: {
          name,
          file: STACK_CONFIG_FILE,
          services: config.services.map((s) => ({
            name: s.name,
            kind: kindOf(s),
            image: s.image,
            dockerfile: s.dockerfile,
            port: s.port,
            hostname: isStack ? stackHostname(name, s.name) : undefined,
            resources: sized(ctx, s),
            monthly: monthly(s),
          })),
          inputs: config.inputs.map((i) => i.key),
        },
        region,
        total: prices ? total : null,
      },
      render: () => ({
        table: {
          columns,
          rows,
          footer: `region ${region}${prices ? ` — total $${total.toFixed(2)}/mo` : ''}`,
        },
      }),
    };
  }

  const inputs = resolveInputs(
    config,
    await promptInputs(ctx, config, provided),
  );

  for (const l of [columns.join('  '), ...rows.map((r) => r.join('  '))])
    process.stderr.write(`${sanitize(l)}\n`);
  if (
    ctx.io.interactive &&
    !ctx.flags.yes &&
    !(await confirm(
      {
        message: isStack
          ? `Create ${config.services.length} servers in project "${name}"?`
          : `Create server "${name}" in project "${name}"?`,
      },
      ctx.io.theme,
    ))
  )
    return { data: { cancelled: true }, render: () => ({ lines: [] }) };

  const teamId = ctx.flags.workspace
    ? await resolveOption(
        ctx,
        ['workspaces'],
        ctx.flags.workspace,
        ['id', 'name'],
        'workspace',
      )
    : undefined;

  const render: RenderContext = {
    inputs,
    secrets: generateSecrets(config),
    services: {},
  };
  const created: Array<{
    service: StackService;
    id: string;
    name: string;
    hostname?: string;
  }> = [];
  const warnings: string[] = [];
  const warn = (w: string) => {
    warnings.push(w);
    process.stderr.write(`! ${sanitize(w)}\n`);
  };

  const proj = await task('Creating project', ctx.io.theme, () =>
    ctx.api().post(['projects'], {
      name,
      description: `Deployed from ${STACK_CONFIG_FILE}`,
      ...(teamId ? { workspace_id: teamId } : {}),
    }),
  );
  const projectId = String(proj?.project?.id ?? proj?.id ?? '');
  if (!projectId) throw new CliError('server', 'Could not create the project');
  const prodId = String(
    (proj?.project?.environments ?? proj?.environments ?? []).find(
      (e: any) => e.kind === 'production' || e.name === 'production',
    )?.id ?? '',
  );

  try {
    for (const s of config.services) {
      const serverName = isStack ? `${name}-${s.name}` : name;
      const size = sized(ctx, s);
      const body: Record<string, unknown> = {
        name: serverName,
        daemonId: region,
        ram: size.ram,
        cpu: size.cpu,
        disk: size.disk,
        variables: renderEnv(s, render),
        autoStart: false,
        ...(teamId ? { teamId } : {}),
        ...(s.dockerfile ? { mode: 'git' } : { mode: 'image', image: s.image }),
        ...(s.port !== undefined ? { appPort: s.port } : {}),
        ...(s.dataPath !== undefined ? { dataPath: s.dataPath } : {}),
      };
      const r = await task(`Creating ${serverName}`, ctx.io.theme, () =>
        ctx.api().post(['servers'], body),
      );
      const id = String(r?.id ?? '');
      if (!id) {
        throw new CliError(
          'server',
          `Could not create ${s.name}${r?.message ? `: ${r.message}` : ''}`,
        );
      }
      const entry: (typeof created)[number] = {
        service: s,
        id,
        name: serverName,
      };
      created.push(entry);

      if (s.ports.length) {
        await ctx.api().put(['servers', id, 'ports'], {
          ports: s.ports.map((p) => ({
            internalPort: p.internalPort,
            protocol: p.protocol,
          })),
        });
      }

      if (isStack) {
        const hostname = stackHostname(name, s.name);
        await ctx.api().put(['servers', id, 'private-network'], {
          enabled: true,
          hostname,
        });
        entry.hostname = hostname;
        const port = s.port ?? (await assignedPort(ctx, id));
        if (!port) {
          throw new CliError(
            'server',
            `Timed out waiting for ${s.name}'s port`,
          );
        }
        render.services[s.name] = { host: `${hostname}.internal`, port };
      }
      if (prodId) {
        try {
          await ctx
            .api()
            .put(['projects', projectId, 'environments', prodId, 'resources'], {
              type: 'server',
              id,
            });
        } catch (e) {
          warn(
            `${s.name}: could not add to the project: ${e instanceof Error ? e.message : 'failed'}`,
          );
        }
      }
    }
  } catch (e) {
    if (created.length) {
      process.stderr.write('Failed before anything started. Created so far:\n');
      for (const c of created)
        process.stderr.write(
          `${sanitize(`  ${c.name} (${c.id}) — delete with: bitqate servers delete ${c.name}`)}\n`,
        );
    }
    throw e;
  }

  const linkOut: ComposeLink = {
    project: { id: projectId, name },
    services: Object.fromEntries(
      created.map((c) => [c.service.name, { id: c.id, name: c.name }]),
    ),
  };
  writeComposeLink(dir, linkOut);

  const { uploadPackage } = await import('./servers');
  for (const c of created) {
    try {
      if (c.service.dockerfile) {
        await uploadPackage(
          ctx,
          c.id,
          await packageService(ctx, dir, c.service),
        );
      } else {
        await task(`Starting ${c.name}`, ctx.io.theme, () =>
          ctx.api().post(['servers', c.id, 'start']),
        );
      }
    } catch (e) {
      warn(
        `${c.service.name}: could not start: ${e instanceof Error ? e.message : 'failed'}`,
      );
    }
  }

  if (warnings.length) {
    throw new CliError(
      'server',
      'Some steps failed — see the warnings above. Created resources were left in place.',
    );
  }

  const results = created.map((c) => ({
    service: c.service.name,
    kind: kindOf(c.service),
    id: c.id,
    name: c.name,
    hostname: c.hostname ?? null,
  }));
  return {
    data: {
      project: { id: projectId, name },
      services: results,
    },
    render: () => ({
      table: {
        columns: ['service', 'kind', 'name', 'hostname'],
        rows: results.map((r) => [
          r.service,
          r.kind,
          r.name,
          r.hostname ? `${r.hostname}.internal` : '—',
        ]),
      },
    }),
  };
}
