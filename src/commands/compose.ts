import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import type { RunContext } from '../registry';
import { CliError as BQError, CliError, usageError } from '../core/errors';
import { planCompose, rewriteDbPorts } from '../core/compose';
import type { PlannedService, ComposePlan } from '../core/compose';
import { DATABASES } from '../data/images';
import { resolveOption } from '../core/resolve';
import { priceMap, serverMonthly } from '../core/pricing';
import { confirm } from '../ui/prompts';
import { task } from '../ui/spinner';
import { sanitize } from '../core/output';

export const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];

export interface ComposeLink {
  project: { id: string; name: string };
  services: Record<string, { id: string; name: string }>;
}

export function findComposeFile(dir: string): string | null {
  for (const f of COMPOSE_FILES) if (fs.existsSync(path.join(dir, f))) return f;
  return null;
}

export function readComposeLink(dir: string): ComposeLink | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, '.bitqate.json'), 'utf8'),
    );
    return raw.project?.id && raw.services ? (raw as ComposeLink) : null;
  } catch {
    return null;
  }
}

export function writeComposeLink(dir: string, link: ComposeLink) {
  fs.writeFileSync(
    path.join(dir, '.bitqate.json'),
    JSON.stringify(link, null, 2) + '\n',
  );
}

export function databaseImage(s: PlannedService): string {
  const entry = DATABASES.find((d) => d.engine === s.engine);
  const img = String(s.image ?? '');
  const tagged = img.includes(':') && !img.endsWith(':latest');
  return tagged ? img : (entry?.image ?? img);
}

export function serviceBody(
  s: PlannedService,
  opts: { region: string },
): { body: Record<string, unknown>; extraPorts: number[] } {
  const body: Record<string, unknown> = {
    name: s.name,
    daemonId: opts.region,
    ram: s.memoryMb,
    cpu: Math.round(s.cpu * 100),
    disk: s.diskGb,
    variables: s.env,
  };
  if (s.extraMounts.length) {
    body.extraMounts = s.extraMounts.map((m) => ({
      containerPath: m.target,
    }));
  }
  const extraPorts = s.extraPorts.filter((p) => p >= 1024);
  if (s.kind === 'database') {
    body.mode = 'image';
    body.image = databaseImage(s);
  } else if (s.kind === 'image') {
    body.mode = 'image';
    body.image = s.image;
    if (s.command) body.startup = s.command;
  } else {
    body.mode = 'git';
    if (s.appPort) body.appPort = s.appPort;
    if (s.dataPath) body.dataPath = s.dataPath;
  }
  return { body, extraPorts };
}

export function dryRunPlan(
  plan: ComposePlan,
  region: string,
  prices: ReturnType<typeof priceMap> | null,
): Record<string, unknown> {
  const rows = plan.services.map((s) => {
    const monthly =
      prices &&
      serverMonthly(
        {
          ram_mb: s.memoryMb,
          cpu_units: Math.round(s.cpu * 100),
          disk_gb: s.diskGb,
        },
        prices,
      );
    return {
      name: s.name,
      hostname: s.hostname,
      kind: s.kind,
      engine: s.engine,
      image: s.image,
      build: s.build,
      appPort: s.appPort,
      dataPath: s.dataPath,
      memoryMb: s.memoryMb,
      cpu: s.cpu,
      diskGb: s.diskGb,
      monthly,
      warnings: s.warnings,
    };
  });
  const total = rows.reduce((t, r) => t + (r.monthly ?? 0), 0);
  return {
    plan: {
      name: plan.name,
      services: rows.map(({ monthly, ...rest }) => rest),
      warnings: plan.warnings,
    },
    region,
    prices: prices
      ? rows.map((r) => ({ name: r.name, monthly: r.monthly }))
      : null,
    total: prices ? total : null,
  };
}

export async function runCompose(
  ctx: RunContext,
  dir: string,
  file: string,
): Promise<{ data: any; render: (d: any, ui: any) => any }> {
  const doc = parseYaml(fs.readFileSync(path.join(dir, file), 'utf-8'));
  const plan = planCompose(doc, {
    dir,
    memoryMb: ctx.flags['memory-mb']
      ? Number(ctx.flags['memory-mb'])
      : undefined,
    cpus: ctx.flags.cpus ? Number(ctx.flags.cpus) : undefined,
    diskGb: ctx.flags['disk-gb'] ? Number(ctx.flags['disk-gb']) : undefined,
  });
  if (!plan.services.length)
    throw usageError('No services in the compose file');

  const link = readComposeLink(dir);

  if (link) {
    const { packageDir, uploadPackage } = await import('./servers');
    const out: string[] = [];
    for (const s of plan.services) {
      const cur = link.services[s.name];
      if (!cur) {
        out.push(`${s.name}: not linked — create it in the dashboard`);
        continue;
      }
      if (s.kind !== 'build') {
        out.push(`${s.name} (${s.kind}): unchanged`);
        continue;
      }
      const ctxDir = path.resolve(dir, s.build?.context ?? '.');
      const pkg = await packageDir(
        {
          ...ctx,
          flags: {
            ...ctx.flags,
            dockerfile: s.build?.dockerfile
              ? path.join(ctxDir, s.build.dockerfile)
              : undefined,
          },
        },
        ctxDir,
      );
      await uploadPackage(ctx, cur.id, pkg);
      out.push(`${s.name}: re-uploaded to ${cur.name}`);
    }
    for (const l of out) console.error(l);
    return {
      data: { ok: true, reUpload: true },
      render: () => ({ lines: out }),
    };
  }

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

  const allWarnings = [
    ...plan.warnings,
    ...plan.services.flatMap((s) => s.warnings),
  ];
  const money = (s: PlannedService) =>
    prices
      ? `$${serverMonthly({ ram_mb: s.memoryMb, cpu_units: Math.round(s.cpu * 100), disk_gb: s.diskGb }, prices)?.toFixed(2) ?? '?'}/mo`
      : 'prices need a login';

  if (ctx.flags['dry-run']) {
    return {
      data: dryRunPlan(plan, region, prices),
      render: (d: any) => ({
        table: {
          columns: [
            'service',
            'kind',
            'source',
            'ram',
            'cpu',
            'disk',
            'monthly',
          ],
          rows: plan.services.map((s) => [
            s.name,
            s.kind,
            s.image ?? s.build?.context ?? '',
            `${s.memoryMb}MB`,
            `${s.cpu}`,
            `${s.diskGb}GB`,
            money(s),
          ]),
          footer: `region ${region}${d?.prices ? ` — total $${Number(d.total).toFixed(2)}/mo` : ''}`,
        },
      }),
    };
  }

  const table = {
    columns: ['service', 'kind', 'source', 'ram', 'cpu', 'disk', 'monthly'],
    rows: plan.services.map((s) => [
      s.name,
      s.kind,
      s.image ?? s.build?.context ?? '',
      `${s.memoryMb}MB`,
      `${s.cpu}`,
      `${s.diskGb}GB`,
      money(s),
    ]),
  };
  for (const l of [
    table.columns.join('  '),
    ...table.rows.map((r) => r.join('  ')),
    ...allWarnings.map((w) => `! ${w}`),
  ])
    process.stderr.write(sanitize(l) + '\n');
  if (
    ctx.io.interactive &&
    !ctx.flags.yes &&
    !(await confirm(
      {
        message: `Create ${plan.services.length} servers in project "${plan.name}"?`,
      },
      ctx.io.theme,
    ))
  )
    return { data: { cancelled: true }, render: () => ({ lines: [] }) };

  const created: Array<{ name: string; id: string }> = [];
  const perWarnings = new Map<string, string[]>();
  const warn = (name: string, w: string) => {
    perWarnings.set(name, [...(perWarnings.get(name) ?? []), w]);
    process.stderr.write(`! ${sanitize(w)}\n`);
  };
  const failList = () =>
    created.map(
      (c) =>
        `  ${c.name} (${c.id}) — delete with: bitqate servers delete ${c.name}`,
    );

  try {
    const proj = await task('Creating project', ctx.io.theme, () =>
      ctx.api().post(['projects'], { name: plan.name }),
    );
    const projectId = String(proj?.project?.id ?? proj?.id ?? '');
    const prod = (proj?.project?.environments ?? proj?.environments ?? []).find(
      (e: any) => e.kind === 'production' || e.name === 'production',
    );
    const prodId = String(prod?.id ?? '');

    const assigned = new Map<string, number>();
    for (const s of plan.services.filter((x) => x.kind === 'database')) {
      const { body } = serviceBody(s, { region });
      const r = await task(`Creating ${s.name}`, ctx.io.theme, () =>
        ctx.api().post(['servers'], body),
      );
      const id = String(r?.id ?? '');
      if (!id) throw new CliError('server', `Could not create ${s.name}`);
      created.push({ name: s.name, id });
      const deadline = Date.now() + 60_000;
      for (;;) {
        const info = await ctx.api().get(['servers', id]);
        const port = info?.server?.address?.port ?? info?.address?.port;
        if (port) {
          assigned.set(s.name, Number(port));
          break;
        }
        if (Date.now() > deadline) {
          warn(
            s.name,
            `timed out waiting for ${s.name}'s port; its env was not rewritten`,
          );
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    for (const w of rewriteDbPorts(plan.services, assigned)) warn('plan', w);

    for (const s of plan.services.filter((x) => x.kind !== 'database')) {
      const { body, extraPorts } = serviceBody(s, { region });
      const r = await task(`Creating ${s.name}`, ctx.io.theme, () =>
        ctx.api().post(['servers'], body),
      );
      const id = String(r?.id ?? '');
      if (!id) throw new CliError('server', `Could not create ${s.name}`);
      created.push({ name: s.name, id });
      if (s.kind === 'build') {
        const ctxDir = path.resolve(dir, s.build?.context ?? '.');
        const { packageDir, uploadPackage } = await import('./servers');
        const pkg = await packageDir(
          {
            ...ctx,
            flags: {
              ...ctx.flags,
              dockerfile: s.build?.dockerfile
                ? path.join(ctxDir, s.build.dockerfile)
                : undefined,
            },
          },
          ctxDir,
        );
        await uploadPackage(ctx, id, pkg);
      }
      for (const port of extraPorts) {
        try {
          await ctx.api().put(['servers', id, 'ports'], {
            ports: [{ internalPort: port }],
          });
        } catch (e) {
          warn(
            s.name,
            `could not add port ${port}: ${e instanceof Error ? e.message : 'failed'}`,
          );
        }
      }
    }

    const results: Array<Record<string, unknown>> = [];
    const linkOut: ComposeLink = {
      project: { id: projectId, name: plan.name },
      services: {},
    };
    for (const s of plan.services) {
      const c = created.find((x) => x.name === s.name);
      if (!c) continue;
      linkOut.services[s.name] = { id: c.id, name: c.name };
      let address: string | null = null;
      try {
        const info = await ctx.api().get(['servers', c.id]);
        const a = info?.server?.address ?? info?.address;
        address = a?.host && a?.port ? `${a.host}:${a.port}` : null;
      } catch {}
      try {
        await ctx.api().put(['servers', c.id, 'private-network'], {
          enabled: true,
          hostname: s.hostname,
        });
      } catch (e) {
        warn(
          s.name,
          `could not enable private networking: ${e instanceof Error ? e.message : 'failed'}`,
        );
      }
      if (prodId) {
        try {
          await ctx
            .api()
            .put(['projects', projectId, 'environments', prodId, 'resources'], {
              type: 'server',
              id: c.id,
            });
        } catch (e) {
          warn(
            s.name,
            `could not add to the project: ${e instanceof Error ? e.message : 'failed'}`,
          );
        }
      }
      results.push({
        name: s.name,
        kind: s.kind,
        id: c.id,
        address,
        hostname: s.hostname,
        warnings: perWarnings.get(s.name) ?? [],
      });
    }
    writeComposeLink(dir, linkOut);

    const failed = results.some((r) => (r.warnings as string[]).length);
    if (failed) {
      throw new CliError(
        'server',
        'Some steps failed — see the warnings above. Created resources were left in place.',
      );
    }
    return {
      data: {
        project: { id: projectId, name: plan.name },
        services: results,
      },
      render: (_d: any) => ({
        table: {
          columns: ['service', 'kind', 'name', 'address', 'hostname'],
          rows: results.map((r) => [
            String(r.name),
            String(r.kind),
            String(linkOut.services[String(r.name)]?.name ?? ''),
            String(r.address ?? '—'),
            String(r.hostname),
          ]),
        },
      }),
    };
  } catch (e) {
    if (created.length) {
      process.stderr.write('Failed partway through. Created so far:\n');
      for (const l of failList()) process.stderr.write(`${sanitize(l)}\n`);
    }
    throw e;
  }
}
