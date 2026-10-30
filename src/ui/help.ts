import {
  commandAliases,
  groups,
  subcommandsOf,
  type Command,
} from '../registry';
import type { Theme } from './theme';

const DOCS = 'https://portal.bitqate.com/docs';
const PORTAL = 'https://portal.bitqate.com';

const ROOT_SECTIONS: [string, [string, string][]][] = [
  [
    'Core',
    [
      ['vms', 'Create and manage virtual private servers'],
      ['servers', 'Deploy containers, game servers and apps'],
    ],
  ],
  [
    'Account',
    [
      ['account', 'Your account and balance'],
      ['workspaces', 'Workspaces you belong to'],
      ['transactions', 'Billing history'],
      ['prices', 'Resource prices'],
    ],
  ],
  [
    'Setup',
    [
      ['auth', 'Log in and manage tokens'],
      ['completion', 'Shell completion'],
    ],
  ],
  [
    'Tools',
    [
      ['open', 'Open a resource in the dashboard'],
      ['schema', 'Machine-readable command list for agents'],
      ['version', 'Print the CLI version'],
      ['help', 'Show help'],
    ],
  ],
];

const GLOBAL_FLAGS_LIST: [string, string][] = [
  ['--json', 'Machine-readable JSON'],
  ['--yes, -y', 'Skip confirmations'],
  ['--quiet, -q', 'Print only resource IDs'],
  ['--profile <name>', 'Config profile to use'],
  ['--dry-run', 'Print the request without sending it'],
  ['--verbose', 'Log requests to stderr'],
  ['--no-color', 'Disable colored output'],
  ['--help, -h', 'Show help'],
];

function globalFlagsBlock(theme: Theme): string[] {
  const w = Math.max(...GLOBAL_FLAGS_LIST.map(([n]) => n.length));
  return GLOBAL_FLAGS_LIST.map(
    ([n, d]) => `  ${n.padEnd(w)}  ${theme.paint('muted', d)}`,
  );
}

function tagsColumn(cmd: Command): string {
  const out: string[] = [];
  if (cmd.charges) out.push('charges balance');
  if (cmd.destructive) out.push('destructive');
  return out.join(' ');
}

export function rootHelp(theme: Theme): string {
  const lines: string[] = [];
  const w = Math.max(
    ...ROOT_SECTIONS.flatMap(([, items]) => items.map(([n]) => n.length)),
  );
  for (const [section, items] of ROOT_SECTIONS) {
    lines.push(theme.paint('muted', section));
    for (const [n, d] of items)
      lines.push(`  ${theme.paint('strong', n.padEnd(w))}  ${d}`);
    lines.push('');
  }
  lines.push(theme.paint('muted', 'Flags'), ...globalFlagsBlock(theme), '');
  lines.push(theme.paint('muted', 'Examples'));
  for (const e of [
    'bitqate vms list',
    'bitqate vms create',
    'bitqate servers deploy api --follow',
    'bitqate vms ssh dizzy-puma',
  ])
    lines.push(`  ${e}`);
  lines.push(
    '',
    'Run bitqate <command> --help for details.',
    `  ${theme.paint('muted', 'Docs')}  ${DOCS}`,
  );
  return lines.join('\n');
}

const GROUP_SECTIONS: Record<string, [string, string[]][]> = {
  vms: [
    [
      'Manage',
      [
        'list',
        'get',
        'create',
        'rename',
        'resize',
        'renew',
        'auto-renew',
        'reinstall',
        'delete',
      ],
    ],
    ['Power', ['start', 'stop', 'restart']],
    ['Connect', ['ssh', 'open']],
    [
      'Backups',
      ['backups list', 'backups create', 'backups restore', 'backups delete'],
    ],
    ['Network', ['networking', 'rdns']],
    ['Info', ['nodes', 'os', 'stats', 'wait']],
  ],
  'vms backups': [['Backups', ['list', 'create', 'restore', 'delete']]],
  servers: [
    [
      'Manage',
      [
        'list',
        'get',
        'create',
        'rename',
        'resize',
        'renew',
        'auto-renew',
        'reinstall',
        'delete',
      ],
    ],
    ['Power', ['start', 'stop', 'restart']],
    ['Connect', ['open']],
    [
      'Deploy',
      [
        'deploy',
        'deployments list',
        'deployments get',
        'deployments logs',
        'deployments redeploy',
        'deployments rollback',
      ],
    ],
    ['Config', ['startup', 'ports']],
    [
      'Backups',
      ['backups list', 'backups create', 'backups restore', 'backups delete'],
    ],
    ['Info', ['regions', 'install-state', 'wait']],
  ],
  'servers deployments': [
    ['Deployments', ['list', 'get', 'logs', 'redeploy', 'rollback']],
  ],
  'servers backups': [['Backups', ['list', 'create', 'restore', 'delete']]],
  auth: [
    ['Profiles', ['login', 'logout', 'list', 'switch']],
    ['Info', ['status']],
  ],
  workspaces: [['Workspaces', ['list']]],
  transactions: [['Transactions', ['list']]],
};

export function groupHelp(path: string[], theme: Theme): string {
  const key = path.join(' ');
  const g = groups.find((g) => g.path.join(' ') === key);
  const subs = subcommandsOf(path);
  const sections = GROUP_SECTIONS[key] ?? [['Commands', subs.map(() => '')]];
  const width =
    (typeof process.stdout.columns === 'number'
      ? process.stdout.columns
      : 80) || 80;

  const lines: string[] = [];
  if (g?.summary) lines.push(g.summary, '');
  lines.push(theme.paint('muted', 'Usage'));
  lines.push(`  bitqate ${key} <command> [flags]`, '');
  const printed = new Set<string>();
  const sectionItems: [string, Command[]][] = [];
  const rest: Command[] = [];
  for (const [section, names] of sections) {
    const items: Command[] = [];
    for (const n of names) {
      for (const c of subs) {
        if (
          c.path.slice(path.length).join(' ') === n &&
          !printed.has(c.path.join(' '))
        ) {
          printed.add(c.path.join(' '));
          items.push(c);
        }
      }
    }
    if (items.length) sectionItems.push([section, items]);
  }
  for (const c of subs)
    if (!printed.has(c.path.join(' '))) {
      printed.add(c.path.join(' '));
      rest.push(c);
    }
  const all = sectionItems.flatMap(([, items]) => items).concat(rest);
  const nameW = Math.max(
    ...all.map((c) => c.path.slice(path.length).join(' ').length),
  );
  const leftW = Math.max(
    ...all.map((c) => `  ${' '.repeat(nameW)}  ${c.summary}`.length),
  );
  const render = (c: Command) => {
    const name = c.path.slice(path.length).join(' ');
    const tag = tagsColumn(c);
    const left = `  ${name.padEnd(nameW)}  ${c.summary}`;
    return tag ? left.padEnd(leftW + 2) + theme.paint('muted', tag) : left;
  };
  for (const [section, items] of sectionItems) {
    lines.push(theme.paint('muted', section));
    for (const c of items) lines.push(render(c));
    lines.push('');
  }
  for (const c of rest) lines.push(render(c));
  if (lines[lines.length - 1] === '') lines.pop();
  lines.push(
    '',
    theme.paint('muted', `Run bitqate ${key} <command> --help for details.`),
  );
  return lines.join('\n');
}

export function commandUsage(cmd: Command): string {
  const parts = ['bitqate', ...cmd.path];
  for (const arg of cmd.args)
    parts.push(arg.required === false ? `[${arg.name}]` : `<${arg.name}>`);
  if (Object.keys(cmd.flags).length) parts.push('[flags]');
  return parts.join(' ');
}

export function commandHelp(cmd: Command, theme: Theme): string {
  const lines: string[] = [cmd.summary, ''];
  lines.push(theme.paint('muted', 'Usage'), `  ${commandUsage(cmd)}`);
  if (cmd.interactive)
    lines.push(
      '',
      `  ${theme.paint('muted', 'Runs interactively when flags are omitted on a terminal.')}`,
    );
  if (cmd.args.length) {
    lines.push('', theme.paint('muted', 'Arguments'));
    const w = Math.max(...cmd.args.map((a) => a.name.length));
    for (const a of cmd.args)
      lines.push(`  ${a.name.padEnd(w)}  ${a.description ?? ''}`.trimEnd());
  }
  const flags = Object.entries(cmd.flags);
  if (flags.length) {
    lines.push('', theme.paint('muted', 'Flags'));
    const names = flags.map(([n, s]) =>
      s.type === 'string' ? `--${n} <${s.placeholder ?? 'value'}>` : `--${n}`,
    );
    const w = Math.max(...names.map((n) => n.length));
    flags.forEach(([n, s], i) => {
      const bits = [s.description];
      if (s.required) bits.push('required');
      if (s.multiple) bits.push('repeatable');
      if (s.short) bits.push(`-${s.short}`);
      lines.push(`  ${names[i].padEnd(w)}  ${bits.join(' · ')}`);
    });
  }
  lines.push(
    '',
    theme.paint('muted', 'Global flags'),
    ...globalFlagsBlock(theme),
  );
  const alias = commandAliases(cmd);
  if (alias.length)
    lines.push('', theme.paint('muted', 'Aliases'), `  ${alias.join(', ')}`);
  if (cmd.examples.length) {
    lines.push('', theme.paint('muted', 'Examples'));
    for (const e of cmd.examples) lines.push(`  ${e}`);
  }
  const footer: string[] = [];
  if (cmd.scope)
    footer.push(
      `Requires the ${cmd.scope === 'any' ? 'any valid token' : `${cmd.scope} scope`}`,
    );
  if (cmd.charges) footer.push('charges your balance');
  if (cmd.destructive) footer.push('destructive: asks for confirmation');
  if (footer.length) lines.push('', theme.paint('muted', footer.join(' · ')));
  return lines.join('\n');
}
