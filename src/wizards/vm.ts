import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { CliError, usageError } from '../core/errors';
import { vmMonthly } from '../core/pricing';
import { priceMap } from '../core/pricing';
import { task } from '../ui/spinner';
import { confirm, select, text } from '../ui/prompts';
import { elapsedLong, memory, moneyMo } from '../ui/format';
import { positiveInt, validateSshPublicKey } from '../core/validate';
import type { RunContext } from '../registry';
import {
  answered,
  confirmCreate,
  loadForWizard,
  pickWorkspace,
  reviewBlock,
} from './shared';

const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

const VM_SIZES = [
  { cpu: 1, mem: 1024, disk: 20 },
  { cpu: 2, mem: 2048, disk: 40 },
  { cpu: 2, mem: 4096, disk: 60 },
  { cpu: 4, mem: 8192, disk: 80 },
  { cpu: 8, mem: 16384, disk: 160 },
];

const VM_OK = new Set(['active', 'running']);
const VM_FAIL = new Set(['error', 'suspended']);

function listSshKeys(): { file: string; label: string; key: string }[] {
  const dir = join(homedir(), '.ssh');
  if (!existsSync(dir)) return [];
  const out: { file: string; label: string; key: string }[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.pub')) continue;
    try {
      const key = validateSshPublicKey(readFileSync(join(dir, f), 'utf8'));
      const comment = key.split(' ').slice(2).join(' ');
      out.push({ file: join(dir, f), key, label: f });
    } catch {}
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

export async function vmWizard(ctx: RunContext): Promise<any> {
  const theme = ctx.io.theme;
  const { results, account, workspaces } = await task(
    'Loading options',
    theme,
    () =>
      loadForWizard(ctx, {
        nodes: ['vm-nodes'],
        oss: ['operating-systems'],
        prices: ['prices'],
      }),
    { endStyle: 'clear' },
  );
  const nodeList: any[] = results.nodes?.nodes ?? [];
  const osList: any[] = results.oss?.operating_systems ?? [];
  const prices = priceMap(results.prices?.prices);

  let node = ctx.flags.node;
  if (!node) {
    if (nodeList.length === 1) {
      node = nodeList[0].id;
      answered(theme, 'Region', nodeList[0].nickname || nodeList[0].name);
    } else {
      node = await select(
        {
          message: 'Region',
          options: nodeList.map((n: any) => ({
            label: n.nickname || n.name,
            value: n.id,
          })),
        },
        theme,
      );
    }
  }
  const nodeObj = nodeList.find((n: any) => n.id === node);

  let os = ctx.flags.os;
  if (!os) {
    const avail = osList.filter((o: any) => (o.node_ids ?? []).includes(node));
    os = await select(
      {
        message: 'Operating system',
        options: avail.map((o: any) => ({ label: o.name, value: o.id })),
      },
      theme,
    );
  }
  const osObj = osList.find((o: any) => o.id === os);

  let cpus = ctx.flags.cpus ? Number(ctx.flags.cpus) : undefined;
  let memMb = ctx.flags['memory-mb']
    ? positiveInt(ctx.flags['memory-mb'], 'memory-mb')
    : undefined;
  let diskGb = ctx.flags['disk-gb']
    ? positiveInt(ctx.flags['disk-gb'], 'disk-gb')
    : undefined;
  if (cpus === undefined || memMb === undefined || diskGb === undefined) {
    const presets = VM_SIZES.map((s) => {
      const price = vmMonthly(
        {
          memory_mb: s.mem,
          cpus: s.cpu,
          disk_gb: s.disk,
          ipv4: !ctx.flags['ipv6-only'],
        },
        prices,
      );
      return {
        label: `${s.cpu} vCPU · ${memory(s.mem)} · ${s.disk} GB`,
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
      cpus = Number(
        await text(
          {
            message: 'CPU cores',
            default: '2',
            validate: (v) =>
              Number(v) > 0 ? null : 'Must be a positive number',
          },
          theme,
        ),
      );
      memMb =
        Number(
          await text(
            {
              message: 'Memory (GB)',
              default: '2',
              validate: (v) =>
                Number(v) > 0 ? null : 'Must be a positive number',
            },
            theme,
          ),
        ) * 1024;
      diskGb = Number(
        await text(
          {
            message: 'Disk (GB)',
            default: '40',
            validate: (v) =>
              Number(v) > 0 ? null : 'Must be a positive number',
          },
          theme,
        ),
      );
    } else {
      cpus = picked.cpu;
      memMb = picked.mem;
      diskGb = picked.disk;
    }
  }

  let ipv4 = true;
  if (ctx.flags['ipv6-only']) ipv4 = false;
  else {
    const ipPrice = prices['ip-vps'];
    const price = ipPrice == null ? null : `+${moneyMo(ipPrice)}`;
    ipv4 = await confirm(
      {
        message: `Public IPv4 address (${ipPrice == null ? 'price unavailable' : price})`,
        label: 'Public IPv4',
        answerText: price ? `yes · ${price}` : undefined,
        default: true,
      },
      theme,
    );
  }

  let name = ctx.flags.name;
  if (!name) {
    name = await text(
      {
        message: 'Name (blank for a generated name)',
        label: 'Name',
        blankLabel: 'generated',
        validate: (v) =>
          !v || NAME_RE.test(v) ? null : 'Letters, digits and dashes only',
      },
      theme,
    );
  }

  let sshKey: string | undefined;
  let sshLabel = 'root password';
  if (ctx.flags['ssh-key-file']) {
    try {
      sshKey = validateSshPublicKey(
        readFileSync(ctx.flags['ssh-key-file'], 'utf8'),
      );
    } catch {
      throw usageError(`Cannot read ${ctx.flags['ssh-key-file']}`);
    }
    sshLabel = basename(ctx.flags['ssh-key-file']);
  } else {
    const keys = listSshKeys();
    const picked = await select(
      {
        message: 'SSH key',
        options: [
          ...keys.map((k) => ({
            label: k.label,
            value: k.key,
          })),
          {
            label: 'Skip (use the root password from the dashboard)',
            value: '',
          },
        ],
      },
      theme,
    );
    sshKey = picked || undefined;
    if (picked)
      sshLabel = keys.find((k) => k.key === picked)?.label ?? 'SSH key';
  }

  const teamId = await pickWorkspace(ctx.flags.workspace, workspaces, theme);

  const monthly = vmMonthly(
    { memory_mb: memMb!, cpus: cpus!, disk_gb: diskGb!, ipv4 },
    prices,
  );
  reviewBlock(
    theme,
    [
      ['Region', nodeObj ? nodeObj.nickname || nodeObj.name : node],
      ['OS', osObj?.name ?? os],
      ['Size', `${cpus} vCPU · ${memory(memMb!)} RAM · ${diskGb} GB disk`],
      ['Network', ipv4 ? 'Public IPv4' : 'IPv6 only'],
      ['SSH key', sshKey ? sshLabel : 'root password'],
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

  await confirmCreate(theme, 'VM', monthly, ctx.io.yes || !!ctx.flags['dry-run']);

  const body: Record<string, unknown> = {
    pve_node_id: node,
    operating_system_id: os,
    memory: memMb,
    cpu: cpus,
    drive: diskGb,
    ipv4,
  };
  if (name) body.name = name;
  if (teamId) body.team_id = teamId;
  if (ctx.flags['auto-renew']) body.auto_renew = true;
  if (sshKey) body.ssh_public_key = sshKey;
  return { body };
}
