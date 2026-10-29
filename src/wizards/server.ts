import { existsSync, readFileSync, statSync } from 'node:fs';
import { CliError, usageError } from '../core/errors';
import { priceMap, serverMonthly } from '../core/pricing';
import { findGame, GAMES, type GameEntry } from '../data/games';
import { task } from '../ui/spinner';
import { select, text } from '../ui/prompts';
import { memory, moneyMo } from '../ui/format';
import { cpusToUnits, parseEnvPairs, positiveInt } from '../core/validate';
import type { RunContext } from '../registry';
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

function readable(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function serverWizard(ctx: RunContext): Promise<any> {
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

  let mode: string;
  let image = ctx.flags.image;
  let eggUrl = ctx.flags['egg-url'];
  let game: GameEntry | undefined;
  let dockerfile: string | undefined;
  let dir: string | undefined;
  let sourceLabel = '';
  if (ctx.flags.dir) {
    mode = 'git';
    dir = String(ctx.flags.dir);
    sourceLabel = dir;
  } else if (ctx.flags.image) {
    mode = 'image';
    sourceLabel = ctx.flags.image;
  } else if (ctx.flags['egg-url']) {
    mode = 'egg';
    sourceLabel = ctx.flags['egg-url'];
  } else if (ctx.flags.game) {
    game = findGame(ctx.flags.game);
    if (!game) throw usageError(`Unknown game '${ctx.flags.game}'`);
    mode = 'egg';
    sourceLabel = game.name;
  } else if (ctx.flags.dockerfile) {
    mode = 'dockerfile';
    try {
      dockerfile = readFileSync(ctx.flags.dockerfile, 'utf8');
    } catch {
      throw usageError(`Cannot read ${ctx.flags.dockerfile}`);
    }
    sourceLabel = ctx.flags.dockerfile;
  } else if (ctx.flags.git) {
    mode = 'git';
    sourceLabel = 'GitHub repository';
  } else {
    mode = await select(
      {
        message: 'Source',
        options: [
          { label: 'Docker image', value: 'image' },
          { label: 'Game server', value: 'egg' },
          { label: 'Dockerfile', value: 'dockerfile' },
          {
            label: 'GitHub repository',
            value: 'git',
            hint: 'connect it in the dashboard afterwards',
          },
          {
            label: 'Local directory',
            value: 'dir',
            hint: 'upload code from this machine',
          },
        ],
      },
      theme,
    );
    if (mode === 'image') {
      image = await text(
        {
          message: 'Image reference',
          validate: (v) => (v ? null : 'Required'),
        },
        theme,
      );
      sourceLabel = image;
    } else if (mode === 'egg') {
      game = await select(
        {
          message: 'Game',
          options: GAMES.map((g) => ({
            label: g.name,
            value: g,
            hint: g.category,
          })),
        },
        theme,
      );
      sourceLabel = game!.name;
    } else if (mode === 'dir') {
      dir = await text(
        {
          message: 'Directory',
          default: '.',
          validate: (v) => {
            try {
              return statSync(v).isDirectory() ? null : 'Not a directory';
            } catch {
              return 'No such directory';
            }
          },
        },
        theme,
      );
      sourceLabel = dir!;
      mode = 'git';
    } else if (mode === 'dockerfile') {
      const path = await text(
        {
          message: 'Dockerfile path',
          default: './Dockerfile',
          validate: (v) => (readable(v) ? null : `Cannot read ${v}`),
        },
        theme,
      );
      dockerfile = readFileSync(path, 'utf8');
      if (Buffer.byteLength(dockerfile) > 65536)
        throw usageError('Dockerfile too large (max 64 KB)');
      sourceLabel = path;
    } else {
      sourceLabel = 'GitHub repository';
    }
  }

  let region = ctx.flags.region;
  if (!region) {
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
    const presets = SERVER_SIZES.map((s) => {
      const price = serverMonthly(
        { ram_mb: s.mem, cpu_units: s.cpu, disk_gb: s.disk },
        prices,
      );
      return {
        label: `${s.cpu / 100} vCPU · ${memory(s.mem)} · ${s.disk} GB`,
        value: s,
        hint: price == null ? 'price unavailable' : moneyMo(price),
      };
    });
    const picked = await select(
      {
        message: 'Size',
        options: [
          ...presets,
          { label: 'Custom…', value: { cpu: 0, mem: 0, disk: 0 } },
        ],
      },
      theme,
    );
    if (!picked.cpu) {
      cpu =
        Number(
          await text(
            {
              message: 'CPU cores (e.g. 1.5)',
              default: '1',
              validate: (v) =>
                Number(v) > 0 ? null : 'Must be a positive number',
            },
            theme,
          ),
        ) * 100;
      ram =
        Number(
          await text(
            {
              message: 'Memory (GB)',
              default: '1',
              validate: (v) =>
                Number(v) > 0 ? null : 'Must be a positive number',
            },
            theme,
          ),
        ) * 1024;
      disk = Number(
        await text(
          {
            message: 'Disk (GB)',
            default: '10',
            validate: (v) =>
              Number(v) > 0 ? null : 'Must be a positive number',
          },
          theme,
        ),
      );
    } else {
      cpu = picked.cpu;
      ram = picked.mem;
      disk = picked.disk;
    }
  }

  let variables: Record<string, string> = game
    ? { ...game.variables }
    : ctx.flags.env?.length
      ? parseEnvPairs(ctx.flags.env)
      : {};
  if (!ctx.flags.env?.length && mode !== 'git') {
    for (;;) {
      const pair = await text(
        {
          message: 'Environment variable KEY=VALUE (blank to finish)',
          label: 'Environment variables',
        },
        theme,
      );
      if (!pair.trim()) break;
      Object.assign(variables, parseEnvPairs([pair]));
    }
  }

  let name = ctx.flags.name;
  if (!name) {
    const slug = (game?.name ?? image ?? 'server')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    name = await text(
      {
        message: 'Name',
        default: slug,
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
      ['Source', sourceLabel],
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
    mode,
  };
  if (mode === 'image') body.image = image;
  if (mode === 'egg') {
    body.eggUrl = game ? game.eggUrl : eggUrl;
    if (game) {
      body.image = game.image;
      body.startup = game.startup;
    }
  }
  if (mode === 'dockerfile') body.dockerfile = dockerfile;
  if (Object.keys(variables).length) body.variables = variables;
  if (ctx.flags.startup) body.startup = ctx.flags.startup;
  if (teamId) body.teamId = teamId;
  return { body, mode, name, dir };
}
