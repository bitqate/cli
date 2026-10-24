import { GLOBAL_FLAG_SPECS } from '../core/args';
import { usageError } from '../core/errors';
import { commandHelp, groupHelp, rootHelp } from '../ui/help';
import {
  commandAliases,
  commands,
  findCommand,
  findGroup,
  groups,
  register,
  subcommandsOf,
} from '../registry';
import pkg from '../../package.json';

function completionScript(shell: string): string {
  const paths = commands.map((c) => c.path.join(' '));
  const top = [
    ...new Set([
      ...commands.map((c) => c.path[0]),
      ...commands
        .filter((c) => c.path.length === 1)
        .flatMap((c) => c.aliases ?? []),
      'whoami',
      'vm',
      'server',
      'srv',
    ]),
  ];
  const globals = Object.keys(GLOBAL_FLAG_SPECS).map((f) => `--${f}`);
  if (shell === 'bash') {
    return `# bash completion for bitqate
_bitqate() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${[...top, ...paths].join(' ')} ${globals.join(' ')}" -- "$cur") )
}
complete -F _bitqate bitqate
`;
  }
  if (shell === 'zsh') {
    return `#compdef bitqate
# zsh completion for bitqate
_bitqate() {
  local -a cmds
  cmds=(${[...top, ...paths, ...globals].map((p) => `'${p}'`).join(' ')})
  _describe 'command' cmds
}
_bitqate "$@"
`;
  }
  if (shell === 'fish') {
    return (
      [...paths, ...top]
        .map((p) => `complete -c bitqate -f -a "${p}"`)
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
    const theme = ctx.io.theme;
    if (!ctx.args.length)
      return {
        data: { help: rootHelp(theme) },
        render: (d) => ({ lines: [d.help] }),
      };
    const cmd = findCommand(ctx.args);
    if (cmd)
      return {
        data: { help: commandHelp(cmd, theme), command: cmd.path.join(' ') },
        render: (d) => ({ lines: [d.help] }),
      };
    if (findGroup(ctx.args) || subcommandsOf(ctx.args).length)
      return {
        data: { help: groupHelp(ctx.args, theme) },
        render: (d) => ({ lines: [d.help] }),
      };
    throw usageError(`Unknown command '${ctx.args.join(' ')}'`);
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
      groups: groups.map((g) => ({
        path: g.path,
        aliases: g.aliases,
        summary: g.summary,
      })),
      commands: [...commands]
        .sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')))
        .map((c) => ({
          path: c.path,
          aliases: c.aliases ?? commandAliases(c),
          summary: c.summary,
          args: c.args,
          flags: c.flags,
          scope: c.scope,
          destructive: !!c.destructive,
          interactive: !!c.interactive,
          charges: !!c.charges,
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
