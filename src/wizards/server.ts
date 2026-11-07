import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CliError, usageError } from '../core/errors';
import { publicRequest } from '../core/client';
import { priceMap, serverMonthly } from '../core/pricing';
import { findGame, GAMES, type GameEntry } from '../data/games';
import {
  DATABASES,
  findDatabase,
  POPULAR_IMAGES,
  type DatabaseEntry,
  type ImageEntry,
} from '../data/images';
import { rootFiles } from '../core/dockerfile';
import { task } from '../ui/spinner';
import { confirm, select, text } from '../ui/prompts';
import { memory, moneyMo } from '../ui/format';
import { cpusToUnits, parseEnvPairs, positiveInt } from '../core/validate';
import type { RunContext } from '../registry';
import type { Theme } from '../ui/theme';
import {
  answered,
  confirmCreate,
  loadForWizard,
  pickWorkspace,
  reviewBlock,
} from './shared';

const NAME_RE = /^[A-Za-z0-9 ._-]+$/;

const SERVER_SIZES = [
  { cpu: 50, mem: 512, disk: 5 },
  { cpu: 100, mem: 1024, disk: 10 },
  { cpu: 100, mem: 2048, disk: 20 },
  { cpu: 200, mem: 4096, disk: 40 },
  { cpu: 400, mem: 8192, disk: 80 },
];

export interface PickedSource {
  mode: 'image' | 'egg' | 'dockerfile' | 'git';
  label: string;
  image?: string;
  eggUrl?: string;
  game?: GameEntry;
  dockerfile?: string;
  dir?: string;
  database?: DatabaseEntry;
  preset?: ImageEntry;
  defaultName: string;
  size?: { cpu: number; mem: number; disk: number };
  env?: Record<string, string>;
}

function readable(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'server'
  );
}

function repoName(image: string): string {
  const last = image.split('/').pop() ?? image;
  return last.split(':')[0] || image;
}

export function describeFolder(dir: string): string {
  const files = rootFiles(dir);
  if (files.includes('Dockerfile')) return 'Dockerfile found';
  if (files.includes('package.json')) return 'Node.js project';
  if (files.includes('go.mod')) return 'Go project';
  if (files.includes('Cargo.toml')) return 'Rust project';
  if (
    files.includes('requirements.txt') ||
    files.includes('pyproject.toml') ||
    files.includes('Pipfile')
  )
    return 'Python project';
  if (files.includes('composer.json')) return 'PHP project';
  if (files.includes('Gemfile')) return 'Ruby project';
  if (files.includes('index.html')) return 'Static site';
  return files.length ? 'no Dockerfile yet' : 'empty folder';
}

export function folderLooksDeployable(dir: string): boolean {
  const d = describeFolder(dir);
  return d !== 'empty folder' && d !== 'no Dockerfile yet';
}

async function searchDockerHub(theme: Theme): Promise<string> {
  for (;;) {
    const q = await text(
      {
        message: 'Search Docker Hub',
        label: 'Search',
        validate: (v) => (v.trim() ? null : 'Type a search term'),
      },
      theme,
    );
    const resp = await task('Searching Docker Hub', theme, () =>
      publicRequest('GET', '/docker/search', {
        query: { q: q.trim(), limit: '15' },
      }).catch(() => null),
    );
    const results: any[] = (resp?.results ?? []).filter(
      (r: any) => typeof r?.name === 'string',
    );
    if (!results.length) {
      process.stderr.write(
        `${theme.paint('muted', `  No images match '${q}'. Try another search.`)}\n`,
      );
      continue;
    }
    const picked = await select<string>(
      {
        message: 'Image',
        options: [
          ...results.map((r) => {
            const name = String(r.name).replace(/^library\//, '');
            const badge = r.official
              ? 'official'
              : r.verified
                ? 'verified'
                : '';
            const pulls =
              r.pulls && r.pulls !== '0M+' ? `${r.pulls} pulls` : '';
            return {
              label: name,
              value: name,
              hint: [badge, pulls, String(r.description ?? '').slice(0, 50)]
                .filter(Boolean)
                .join(' · '),
            };
          }),
          { label: 'Search again…', value: '' },
        ],
      },
      theme,
    );
    if (!picked) continue;
    const tag = await text(
      { message: 'Tag', default: 'latest', label: 'Tag' },
      theme,
    );
    return `${picked}:${tag.trim() || 'latest'}`;
  }
}

async function pickImage(theme: Theme): Promise<PickedSource> {
  const choice = await select<string>(
    {
      message: 'Which app?',
      label: 'App',
      options: [
        ...POPULAR_IMAGES.map((p) => ({
          label: p.name,
          value: p.key,
          hint: p.description,
        })),
        {
          label: 'Search Docker Hub…',
          value: '__search',
          hint: 'any public image',
        },
        {
          label: 'Enter an image name…',
          value: '__custom',
          hint: 'e.g. ghcr.io/org/app:latest',
        },
      ],
    },
    theme,
  );
  if (choice === '__search') {
    const image = await searchDockerHub(theme);
    return {
      mode: 'image',
      image,
      label: image,
      defaultName: slug(repoName(image)),
    };
  }
  if (choice === '__custom') {
    const image = await text(
      {
        message: 'Image reference',
        label: 'Image',
        validate: (v) =>
          /^[a-z0-9][a-z0-9._/:@-]*$/i.test(v.trim())
            ? null
            : 'Enter an image like nginx:latest',
      },
      theme,
    );
    return {
      mode: 'image',
      image: image.trim(),
      label: image.trim(),
      defaultName: slug(repoName(image.trim())),
    };
  }
  const preset = POPULAR_IMAGES.find((p) => p.key === choice)!;
  return {
    mode: 'image',
    image: preset.image,
    label: `${preset.name} (${preset.image})`,
    preset,
    defaultName: slug(preset.name),
    size: preset.size,
    env: preset.env,
  };
}

function databaseSource(db: DatabaseEntry): PickedSource {
  return {
    mode: 'image',
    image: db.image,
    label: `${db.name} (${db.image})`,
    database: db,
    preset: db,
    defaultName: slug(db.name),
    size: db.size,
  };
}

async function pickDatabase(theme: Theme): Promise<PickedSource> {
  const db = await select<DatabaseEntry>(
    {
      message: 'Which database?',
      label: 'Database',
      options: DATABASES.map((d) => ({
        label: d.name,
        value: d,
        hint: d.description,
      })),
    },
    theme,
  );
  return databaseSource(db);
}

async function pickGame(theme: Theme): Promise<PickedSource> {
  const game = await select<GameEntry>(
    {
      message: 'Which game?',
      label: 'Game',
      options: GAMES.map((g) => ({
        label: g.name,
        value: g,
        hint: g.category,
      })),
    },
    theme,
  );
  return {
    mode: 'egg',
    game,
    label: game.name,
    defaultName: slug(game.name),
    size: { cpu: 200, mem: 4096, disk: 40 },
  };
}

async function pickFolder(
  theme: Theme,
  initial?: string,
): Promise<PickedSource> {
  const dir =
    initial ??
    (await text(
      {
        message: 'Folder to deploy',
        label: 'Folder',
        default: '.',
        validate: (v) => {
          try {
            return statSync(v).isDirectory() ? null : 'Not a folder';
          } catch {
            return 'No such folder';
          }
        },
      },
      theme,
    ));
  const base = path.basename(path.resolve(dir));
  return {
    mode: 'git',
    dir,
    label: `${dir === '.' ? `this folder (${base})` : dir}`,
    defaultName: slug(base),
  };
}

export async function pickSource(
  ctx: RunContext,
  opts: { includeFolder?: boolean } = {},
): Promise<PickedSource> {
  const theme = ctx.io.theme;
  const f = ctx.flags;
  if (f.dir) return pickFolder(theme, String(f.dir));
  if (f.database) {
    const db = findDatabase(String(f.database));
    if (!db)
      throw usageError(
        `Unknown database '${f.database}' (choose from ${DATABASES.map((d) => d.key).join(', ')})`,
      );
    return databaseSource(db);
  }
  if (f.image) {
    const image = String(f.image);
    const db = findDatabase(repoName(image));
    if (db) return { ...databaseSource(db), image, label: image };
    return {
      mode: 'image',
      image,
      label: image,
      defaultName: slug(repoName(image)),
    };
  }
  if (f['egg-url'])
    return {
      mode: 'egg',
      eggUrl: String(f['egg-url']),
      label: String(f['egg-url']),
      defaultName: 'game-server',
    };
  if (f.game) {
    const game = findGame(String(f.game));
    if (!game) throw usageError(`Unknown game '${f.game}'`);
    return {
      mode: 'egg',
      game,
      label: game.name,
      defaultName: slug(game.name),
    };
  }
  if (f.dockerfile) {
    let dockerfile: string;
    try {
      dockerfile = readFileSync(String(f.dockerfile), 'utf8');
    } catch {
      throw usageError(`Cannot read ${f.dockerfile}`);
    }
    return {
      mode: 'dockerfile',
      dockerfile,
      label: String(f.dockerfile),
      defaultName: 'app',
    };
  }
  if (f.git)
    return { mode: 'git', label: 'GitHub repository', defaultName: 'app' };

  const cwd = process.cwd();
  const folderHint = `${path.basename(cwd)} · ${describeFolder('.')}`;
  const options = [
    ...(opts.includeFolder !== false
      ? [{ label: 'Code in this folder', value: 'folder', hint: folderHint }]
      : []),
    {
      label: 'Popular app',
      value: 'app',
      hint: 'Nginx, n8n, Uptime Kuma, Ghost, WordPress…',
    },
    {
      label: 'Database',
      value: 'database',
      hint: 'PostgreSQL, MySQL, MongoDB, Redis',
    },
    {
      label: 'Game server',
      value: 'game',
      hint: 'Minecraft, Rust, ARK, Valheim…',
    },
    {
      label: 'Any Docker image',
      value: 'image',
      hint: 'search Docker Hub or type a name',
    },
    {
      label: 'Another folder',
      value: 'otherFolder',
      hint: 'upload code from a different path',
    },
    {
      label: 'A single Dockerfile',
      value: 'dockerfile',
      hint: 'build from one Dockerfile',
    },
    {
      label: 'GitHub repository',
      value: 'git',
      hint: 'connect it in the dashboard afterwards',
    },
  ];
  const kind = await select<string>(
    { message: 'What do you want to deploy?', label: 'Deploy', options },
    theme,
  );
  if (kind === 'folder') return pickFolder(theme, '.');
  if (kind === 'otherFolder') return pickFolder(theme);
  if (kind === 'app') return pickImage(theme);
  if (kind === 'database') return pickDatabase(theme);
  if (kind === 'game') return pickGame(theme);
  if (kind === 'image') {
    const how = await select<string>(
      {
        message: 'How do you want to pick the image?',
        label: 'Image',
        options: [
          { label: 'Search Docker Hub', value: 'search' },
          { label: 'Type the image name', value: 'type' },
        ],
      },
      theme,
    );
    if (how === 'search') {
      const image = await searchDockerHub(theme);
      return {
        mode: 'image',
        image,
        label: image,
        defaultName: slug(repoName(image)),
      };
    }
    const image = (
      await text(
        {
          message: 'Image reference',
          label: 'Image',
          validate: (v) =>
            /^[a-z0-9][a-z0-9._/:@-]*$/i.test(v.trim())
              ? null
              : 'Enter an image like nginx:latest',
        },
        theme,
      )
    ).trim();
    return {
      mode: 'image',
      image,
      label: image,
      defaultName: slug(repoName(image)),
    };
  }
  if (kind === 'dockerfile') {
    const p = await text(
      {
        message: 'Dockerfile path',
        label: 'Dockerfile',
        default: './Dockerfile',
        validate: (v) => (readable(v) ? null : `Cannot read ${v}`),
      },
      theme,
    );
    const dockerfile = readFileSync(p, 'utf8');
    if (Buffer.byteLength(dockerfile) > 65536)
      throw usageError('Dockerfile too large (max 64 KB)');
    return { mode: 'dockerfile', dockerfile, label: p, defaultName: 'app' };
  }
  return { mode: 'git', label: 'GitHub repository', defaultName: 'app' };
}

async function pickSize(
  ctx: RunContext,
  prices: Record<string, number>,
  recommended?: { cpu: number; mem: number; disk: number },
): Promise<{ cpu: number; ram: number; disk: number }> {
  const theme = ctx.io.theme;
  const recIndex = recommended
    ? SERVER_SIZES.findIndex(
        (s) =>
          s.cpu === recommended.cpu &&
          s.mem === recommended.mem &&
          s.disk === recommended.disk,
      )
    : -1;
  const presets = SERVER_SIZES.map((s, i) => {
    const price = serverMonthly(
      { ram_mb: s.mem, cpu_units: s.cpu, disk_gb: s.disk },
      prices,
    );
    const cost = price == null ? 'price unavailable' : moneyMo(price);
    return {
      label: `${s.cpu / 100} vCPU · ${memory(s.mem)} · ${s.disk} GB`,
      value: s,
      hint: i === recIndex ? `${cost} · recommended` : cost,
    };
  });
  const picked = await select(
    {
      message: 'Size',
      initial: recIndex >= 0 ? recIndex : 1,
      options: [
        ...presets,
        { label: 'Custom…', value: { cpu: 0, mem: 0, disk: 0 } },
      ],
    },
    theme,
  );
  if (picked.cpu)
    return { cpu: picked.cpu, ram: picked.mem, disk: picked.disk };
  const num = async (message: string, def: string) =>
    Number(
      await text(
        {
          message,
          default: def,
          validate: (v) => (Number(v) > 0 ? null : 'Must be a positive number'),
        },
        theme,
      ),
    );
  const cpu = Math.round((await num('CPU cores (e.g. 1.5)', '1')) * 100);
  const ram = Math.round((await num('Memory (GB)', '1')) * 1024);
  const disk = Math.round(await num('Disk (GB)', '10'));
  return { cpu, ram, disk };
}

async function askEnv(theme: Theme): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  const want = await confirm(
    {
      message: 'Add environment variables?',
      label: 'Environment variables',
      default: false,
    },
    theme,
  );
  if (!want) return vars;
  for (;;) {
    const pair = await text(
      {
        message: 'KEY=VALUE (leave blank when done)',
        label: 'Variable',
        blankLabel: 'done',
        validate: (v) =>
          !v.trim() || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v.trim())
            ? null
            : 'Use KEY=VALUE',
      },
      theme,
    );
    if (!pair.trim()) break;
    Object.assign(vars, parseEnvPairs([pair.trim()]));
  }
  return vars;
}

export async function serverWizard(
  ctx: RunContext,
  presetSource?: PickedSource,
): Promise<any> {
  const theme = ctx.io.theme;
  const { results, account, workspaces } = await task(
    'Loading options',
    theme,
    () =>
      loadForWizard(ctx, {
        daemons: ['daemons'],
        prices: ['prices'],
      }),
    { endStyle: 'clear' },
  );
  const daemons: any[] = results.daemons?.daemons ?? [];
  const prices = priceMap(results.prices?.prices);

  const source = presetSource ?? (await pickSource(ctx));
  if (presetSource) answered(theme, 'Deploy', source.label);

  if (source.dir && !existsSync(source.dir))
    throw usageError(`No such folder: ${source.dir}`);

  let region = ctx.flags.region;
  if (region && daemons.length) {
    const lower = String(region).toLowerCase();
    const match = daemons.find((d: any) =>
      [d.id, d.name, d.location].some(
        (v) => String(v ?? '').toLowerCase() === lower,
      ),
    );
    if (!match)
      throw usageError(
        `Unknown region '${region}'. Choices: ${daemons.map((d: any) => d.name).join(', ')}`,
      );
    region = match.id;
  }
  if (!region) {
    if (!daemons.length)
      throw new CliError(
        'server',
        'No regions are available right now. Try again shortly.',
      );
    if (daemons.length === 1) {
      region = daemons[0].id;
      answered(theme, 'Region', daemons[0].name);
    } else {
      region = await select(
        {
          message: 'Region',
          options: daemons.map((d: any) => ({
            label: d.name,
            value: d.id,
            hint: d.location,
          })),
        },
        theme,
      );
    }
  }
  const daemonObj = daemons.find((d: any) => d.id === region);

  let ram = ctx.flags['memory-mb']
    ? positiveInt(ctx.flags['memory-mb'], 'memory-mb')
    : undefined;
  let cpu = ctx.flags.cpus ? cpusToUnits(ctx.flags.cpus, 'cpus') : undefined;
  let disk = ctx.flags['disk-gb']
    ? positiveInt(ctx.flags['disk-gb'], 'disk-gb')
    : undefined;
  if (ram === undefined || cpu === undefined || disk === undefined) {
    const s = await pickSize(ctx, prices, source.size);
    cpu ??= s.cpu;
    ram ??= s.ram;
    disk ??= s.disk;
  }

  const variables: Record<string, string> = {
    ...(source.game?.variables ?? {}),
    ...(source.env ?? {}),
  };
  if (ctx.flags.env?.length)
    Object.assign(variables, parseEnvPairs(ctx.flags.env));
  else if (source.mode !== 'git' && !source.database && !source.game)
    Object.assign(variables, await askEnv(theme));

  let name = ctx.flags.name;
  if (!name) {
    name = await text(
      {
        message: 'Name',
        default: source.defaultName,
        validate: (v) =>
          NAME_RE.test(v)
            ? null
            : 'Letters, digits, spaces, dots, _ and - only',
      },
      theme,
    );
  }

  const teamId = await pickWorkspace(ctx.flags.workspace, workspaces, theme);

  const monthly = serverMonthly(
    { ram_mb: ram!, cpu_units: cpu!, disk_gb: disk! },
    prices,
  );
  reviewBlock(
    theme,
    [
      ['Deploy', source.label],
      ['Name', name],
      ['Region', daemonObj?.name ?? region],
      [
        'Size',
        `${(cpu! / 100).toString()} vCPU · ${memory(ram!)} RAM · ${disk} GB disk`,
      ],
      [
        'Billed to',
        teamId
          ? (workspaces.find((w: any) => w.id === teamId)?.name ?? teamId)
          : 'Personal account',
      ],
    ],
    monthly,
    account?.balance ?? null,
  );

  await confirmCreate(
    theme,
    'server',
    monthly,
    ctx.io.yes || !!ctx.flags['dry-run'],
  );

  const body: Record<string, unknown> = {
    name,
    daemonId: region,
    ram,
    cpu,
    disk,
    mode: source.mode,
  };
  if (source.mode === 'image') body.image = source.image;
  if (source.mode === 'egg') {
    body.eggUrl = source.game ? source.game.eggUrl : source.eggUrl;
    if (source.game) {
      body.image = source.game.image;
      body.startup = source.game.startup;
    }
  }
  if (source.mode === 'dockerfile') body.dockerfile = source.dockerfile;
  if (Object.keys(variables).length) body.variables = variables;
  if (ctx.flags.startup) body.startup = ctx.flags.startup;
  if (teamId) body.teamId = teamId;
  return {
    body,
    mode: source.mode,
    name,
    dir: source.dir,
    database: source.database,
  };
}
