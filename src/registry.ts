import type { ApiClient } from './core/client';
import type { CliConfig, ResolvedAuth } from './core/config';
import type { Renderable } from './core/output';

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
  description: string;
}

export type CommandScope = string | 'any' | null;

export interface RunContext {
  api(): ApiClient;
  config: CliConfig;
  auth: ResolvedAuth;
  args: string[];
  flags: Record<string, any>;
  io: {
    json: boolean;
    quiet: boolean;
    yes: boolean;
    color: boolean;
    verbose: boolean;
  };
}

export interface CommandResult<T = any> {
  data: T;
  render?: (data: T, color: boolean) => Renderable;
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
  examples: string[];
  run(ctx: RunContext): Promise<CommandResult>;
}

export const commands: Command[] = [];

export function register(cmd: Command): void {
  commands.push(cmd);
}

export function findCommand(tokens: string[]): Command | undefined {
  const key = tokens.join(' ');
  return commands.find((c) => c.path.join(' ') === key);
}

export function matchPath(tokens: string[]): {
  command?: Command;
  consumed: number;
} {
  let best: { command?: Command; consumed: number } = { consumed: 0 };
  for (const cmd of commands) {
    if (cmd.path.length > tokens.length) continue;
    if (cmd.path.every((p, i) => p === tokens[i])) {
      if (cmd.path.length > best.consumed)
        best = { command: cmd, consumed: cmd.path.length };
    }
  }
  return best;
}
