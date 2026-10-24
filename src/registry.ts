import type { ApiClient } from './core/client';
import type { CliConfig, ResolvedAuth } from './core/config';
import type { Renderable } from './core/output';
import type { Theme } from './ui/theme';

export interface ArgSpec {
  name: string;
  required?: boolean;
  description?: string;
}

export interface FlagSpec {
  type: 'string' | 'boolean';
  multiple?: boolean;
  required?: boolean;
  short?: string;
  placeholder?: string;
  description: string;
}

export type CommandScope = string | 'any' | null;

export interface IoContext {
  json: boolean;
  quiet: boolean;
  yes: boolean;
  interactive: boolean;
  theme: Theme;
  verbose: boolean;
}

export interface RunContext {
  api(): ApiClient;
  config: CliConfig;
  auth: ResolvedAuth;
  args: string[];
  flags: Record<string, any>;
  io: IoContext;
}

export interface CommandResult<T = any> {
  data: T;
  render?: (data: T, ui: IoContext) => Renderable;
}

export interface Command {
  path: string[];
  summary: string;
  description?: string;
  args: ArgSpec[];
  flags: Record<string, FlagSpec>;
  scope: CommandScope;
  destructive?: boolean;
  confirmInside?: boolean;
  interactive?: boolean;
  charges?: boolean;
  aliases?: string[];
  examples: string[];
  run(ctx: RunContext): Promise<CommandResult>;
}

export interface Group {
  path: string[];
  aliases: string[];
  summary: string;
}

export const groups: Group[] = [
  { path: ['auth'], aliases: [], summary: 'Log in and manage tokens' },
  { path: ['account'], aliases: ['whoami'], summary: 'Your account and balance' },
  { path: ['vms'], aliases: ['vm'], summary: 'Create and manage virtual private servers' },
  {
    path: ['servers'],
    aliases: ['server', 'srv'],
    summary: 'Deploy containers, game servers and apps',
  },
];

const SUBCOMMAND_ALIASES: Record<string, string> = {
  ls: 'list',
  show: 'get',
  info: 'get',
  rm: 'delete',
  new: 'create',
};

export const commands: Command[] = [];

export function register(cmd: Command): void {
  commands.push(cmd);
}

export function canonicalize(tokens: string[]): string[] {
  return tokens.map((t, i) => {
    if (i === 0) {
      const g = groups.find((g) => g.path[0] === t || g.aliases.includes(t));
      return g ? g.path[0] : t;
    }
    return SUBCOMMAND_ALIASES[t] ?? t;
  });
}

export function findCommand(tokens: string[]): Command | undefined {
  const key = canonicalize(tokens).join(' ');
  return commands.find((c) => c.path.join(' ') === key);
}

export function matchPath(tokens: string[]): {
  command?: Command;
  consumed: number;
} {
  const canonical = canonicalize(tokens);
  let best: { command?: Command; consumed: number } = { consumed: 0 };
  for (const cmd of commands) {
    if (cmd.path.length > canonical.length) continue;
    if (cmd.path.every((p, i) => p === canonical[i])) {
      if (cmd.path.length > best.consumed)
        best = { command: cmd, consumed: cmd.path.length };
    }
  }
  return best;
}

export function findGroup(tokens: string[]): Group | undefined {
  const canonical = canonicalize(tokens);
  return groups.find(
    (g) =>
      canonical.length >= g.path.length &&
      g.path.every((p, i) => p === canonical[i]),
  );
}

export function subcommandsOf(prefix: string[]): Command[] {
  return commands.filter(
    (c) =>
      c.path.length > prefix.length && prefix.every((p, i) => p === c.path[i]),
  );
}

export function commandAliases(cmd: Command): string[] {
  const out: string[] = [];
  for (const [alias, real] of Object.entries(SUBCOMMAND_ALIASES)) {
    if (cmd.path[cmd.path.length - 1] === real) out.push(alias);
  }
  return out;
}
