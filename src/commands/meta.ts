import { GLOBAL_FLAG_SPECS } from '../core/args';
import { usageError } from '../core/errors';
import { commands, findCommand, register, type Command } from '../registry';
import pkg from '../../package.json';

export function commandUsage(cmd: Command): string {
  const parts = ['bitqate', ...cmd.path];
  for (const arg of cmd.args)
    parts.push(arg.required === false ? `[${arg.name}]` : `<${arg.name}>`);
  if (Object.keys(cmd.flags).length) parts.push('[flags]');
  return parts.join(' ');
}

export function commandHelp(cmd: Command): string {
  const lines: string[] = [];
  lines.push(`Usage: ${commandUsage(cmd)}`);
  lines.push('');
  lines.push(cmd.description ?? cmd.summary);
  if (cmd.args.length) {
    lines.push('', 'Arguments:');
    for (const a of cmd.args)
      lines.push(`  ${a.name.padEnd(14)} ${a.description ?? ''}`.trimEnd());
  }
  const flagEntries = Object.entries(cmd.flags);
  const globalEntries = Object.entries(GLOBAL_FLAG_SPECS);
  lines.push('', 'Flags:');
  for (const [name, spec] of flagEntries) {
    const alias = spec.short ? `-${spec.short}, ` : '    ';
    const mult = spec.multiple ? ' (repeatable)' : '';
    const req = spec.required ? ' (required)' : '';
    lines.push(
      `  ${alias}--${name}${spec.type === 'string' ? ' <value>' : ''}${req}${mult}  ${spec.description}`.trimEnd(),
    );
  }
  lines.push('', 'Global flags:');
  for (const [name, spec] of globalEntries) {
    const alias = spec.short ? `-${spec.short}, ` : '    ';
    lines.push(
      `  ${alias}--${name}${spec.type === 'string' ? ' <value>' : ''}  ${spec.description}`.trimEnd(),
    );
  }
  if (cmd.scope)
    lines.push(
      '',
      `Required token scope: ${cmd.scope === 'any' ? 'any valid token' : cmd.scope}`,
    );
  if (cmd.destructive)
    lines.push('', 'Destructive: requires --yes outside an interactive TTY.');
  if (cmd.examples.length) {
    lines.push('', 'Examples:');
    for (const e of cmd.examples) lines.push(`  ${e}`);
  }
  return lines.join('\n');
}

export function globalHelp(): string {
  const lines: string[] = [
    'bitqate - BitQate command-line interface',
    '',
    'Usage: bitqate <command> [args] [flags]',
    '',
    'Commands:',
  ];
  const sorted = [...commands].sort((a, b) =>
    a.path.join(' ').localeCompare(b.path.join(' ')),
  );
  const width = Math.max(...sorted.map((c) => c.path.join(' ').length));
  for (const cmd of sorted)
    lines.push(`  ${cmd.path.join(' ').padEnd(width)}  ${cmd.summary}`);
  lines.push(
    '',
    'Global flags:',
    ...Object.entries(GLOBAL_FLAG_SPECS).map(([name, spec]) =>
      `  ${spec.short ? `-${spec.short}, ` : ''}--${name}  ${spec.description}`.trimEnd(),
    ),
    '',
    "Run 'bitqate help <command>' for details on a command.",
  );
  return lines.join('\n');
}

function completionScript(shell: string): string {
  const paths = commands.map((c) => c.path.join(' '));
  const top = [...new Set(commands.map((c) => c.path[0]))];
  const globals = Object.keys(GLOBAL_FLAG_SPECS).map((f) => `--${f}`);
  if (shell === 'bash') {
    const cases = paths
      .map((p) => {
        const parts = p.split(' ');
        const depth = parts.length - 1;
        return `    ${depth}) COMPREPLY=( $(compgen -W "${globals.join(' ')}" -- "$cur") ) ;;`;
      })
      .join('\n');
    return `# bash completion for bitqate
_bitqate() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${top.join(' ')}" -- "$cur") )
    return
  fi
  case $COMP_CWORD in
${cases}
    *) COMPREPLY=( $(compgen -W "${globals.join(' ')}" -- "$cur") ) ;;
  esac
}
complete -F _bitqate bitqate
`;
  }
  if (shell === 'zsh') {
    return `#compdef bitqate
# zsh completion for bitqate
_bitqate() {
  local -a cmds
  cmds=(${paths.map((p) => `'${p}'`).join(' ')})
  _describe 'command' cmds
}
_bitqate "$@"
`;
  }
  if (shell === 'fish') {
    return (
      paths.map((p) => {
        const parts = p.split(' ');
        const cond = parts
          .slice(0, -1)
          .map((s, i) => `__fish_seen_subcommand_from ${s}`);
        return `complete -c bitqate -f -n "__fish_use_subcommand" -a "${parts[0]}"`;
      })[0] +
      '\n' +
      paths
        .map((p) => `complete -c bitqate -f -a "${p}" -d "command"`)
        .join('\n') +
      '\n' +
      globals.map((g) => `complete -c bitqate -l ${g.slice(2)} -f`).join('\n') +
      '\n'
    );
  }
  throw usageError(`Unknown shell '${shell}' (expected bash, zsh or fish)`);
}

register({
  path: ['help'],
  summary: 'Show help for a command',
  args: [{ name: 'command', required: false, description: 'Command path' }],
  flags: {},
  scope: null,
  examples: ['bitqate help', 'bitqate help vms create'],
  async run(ctx) {
    if (!ctx.args.length)
      return {
        data: { help: globalHelp() },
        render: (d) => ({ lines: [d.help] }),
      };
    const cmd = findCommand(ctx.args);
    if (!cmd) throw usageError(`Unknown command '${ctx.args.join(' ')}'`);
    return {
      data: { help: commandHelp(cmd), command: cmd.path.join(' ') },
      render: (d) => ({ lines: [d.help] }),
    };
  },
});

register({
  path: ['schema'],
  summary: 'Print the machine-readable command registry as JSON',
  args: [],
  flags: {},
  scope: null,
  examples: ['bitqate schema'],
  async run() {
    const data = {
      version: pkg.version,
      commands: [...commands]
        .sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')))
        .map((c) => ({
          path: c.path,
          summary: c.summary,
          args: c.args,
          flags: c.flags,
          scope: c.scope,
          destructive: !!c.destructive,
          examples: c.examples,
        })),
    };
    return {
      data,
      render: (d) => ({ lines: [JSON.stringify(d, null, 2)] }),
    };
  },
});

register({
  path: ['version'],
  summary: 'Print the CLI version',
  args: [],
  flags: {},
  scope: null,
  examples: ['bitqate version'],
  async run() {
    return {
      data: { version: pkg.version },
      render: (d) => ({ lines: [`bitqate ${d.version}`] }),
    };
  },
});

register({
  path: ['completion'],
  summary: 'Print a shell completion script',
  args: [{ name: 'shell', required: true, description: 'bash, zsh or fish' }],
  flags: {},
  scope: null,
  examples: ['bitqate completion bash'],
  async run(ctx) {
    return {
      data: { script: completionScript(ctx.args[0]) },
      render: (d) => ({ lines: [d.script] }),
    };
  },
});
