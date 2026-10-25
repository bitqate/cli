import { parseArgs } from 'node:util';
import type { Command } from '../registry';
import { usageError } from './errors';

export interface GlobalFlags {
  json: boolean;
  profile?: string;
  yes: boolean;
  quiet: boolean;
  noColor: boolean;
  verbose: boolean;
  dryRun: boolean;
  help: boolean;
}

export const GLOBAL_FLAG_SPECS: Record<
  string,
  { type: 'string' | 'boolean'; short?: string; description: string }
> = {
  json: { type: 'boolean', description: 'Print machine-readable JSON' },
  profile: { type: 'string', description: 'Config profile to use' },
  yes: { type: 'boolean', short: 'y', description: 'Skip confirmations' },
  quiet: {
    type: 'boolean',
    short: 'q',
    description: 'Print only resource IDs for lists',
  },
  'no-color': { type: 'boolean', description: 'Disable colored output' },
  verbose: {
    type: 'boolean',
    description: 'Log request method, URL, status and timing to stderr',
  },
  'dry-run': {
    type: 'boolean',
    description: 'Print the request without sending it',
  },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
};

function levenshtein(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = cur;
    }
  }
  return dp[b.length];
}

export function suggest(name: string, choices: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const choice of choices) {
    const score = levenshtein(name, choice);
    if (score < bestScore) {
      bestScore = score;
      best = choice;
    }
  }
  return bestScore <= 3 ? best : null;
}

const GLOBAL_STRING_FLAGS = new Set(['profile']);
const GLOBAL_SHORT_FLAGS = new Set(['-y', '-q', '-h']);

export function splitGlobalFlags(argv: string[]): {
  flagArgv: string[];
  restArgv: string[];
} {
  const flagArgv: string[] = [];
  const restArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const bare = tok.startsWith('--') ? tok.slice(2).split('=')[0] : '';
    const isGlobal = tok.startsWith('--')
      ? bare in GLOBAL_FLAG_SPECS
      : GLOBAL_SHORT_FLAGS.has(tok);
    if (!isGlobal) {
      restArgv.push(tok);
      continue;
    }
    flagArgv.push(tok);
    if (
      tok.startsWith('--') &&
      GLOBAL_STRING_FLAGS.has(bare) &&
      !tok.includes('=') &&
      i + 1 < argv.length
    ) {
      flagArgv.push(argv[++i]);
    }
  }
  return { flagArgv, restArgv };
}

export function destructiveGate(opts: {
  json: boolean;
  yes: boolean;
  tty: boolean;
}): 'proceed' | 'prompt' | 'require-yes' {
  if (opts.yes) return 'proceed';
  if (opts.json || !opts.tty) return 'require-yes';
  return 'prompt';
}

export interface ParsedCommandLine {
  flags: Record<string, any>;
  positionals: string[];
}

export function parseCommandLine(
  cmd: Command,
  argv: string[],
): ParsedCommandLine {
  const options: Record<
    string,
    { type: 'string' | 'boolean'; short?: string; multiple?: boolean }
  > = {};
  for (const [name, spec] of Object.entries(GLOBAL_FLAG_SPECS)) {
    options[name] = {
      type: spec.type,
      ...(spec.short ? { short: spec.short } : {}),
    };
  }
  for (const [name, spec] of Object.entries(cmd.flags)) {
    options[name] = {
      type: spec.type,
      ...(spec.short ? { short: spec.short } : {}),
      ...(spec.multiple ? { multiple: spec.multiple } : {}),
    };
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options,
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unknown = /Unknown option '--?([A-Za-z0-9-]+)'/.exec(message);
    if (unknown) {
      const near = suggest(
        unknown[1],
        Object.keys(options).concat(
          Object.values(options)
            .map((o) => o.short)
            .filter((s): s is string => !!s),
        ),
      );
      throw usageError(
        near
          ? `Unknown flag '--${unknown[1]}'. Did you mean '--${near}'?`
          : `Unknown flag '--${unknown[1]}'`,
      );
    }
    throw usageError(message);
  }

  const flags: Record<string, any> = parsed.values;
  const positionals = parsed.positionals;

  const requiredArgs = cmd.args.filter((a) => a.required !== false);
  if (positionals.length < requiredArgs.length) {
    const missing = requiredArgs[positionals.length];
    throw usageError(
      `Missing required argument <${missing.name}>` +
        (missing.description ? `: ${missing.description}` : ''),
    );
  }
  if (positionals.length > cmd.args.length) {
    throw usageError(`Unexpected argument '${positionals[cmd.args.length]}'`);
  }

  for (const [name, spec] of Object.entries(cmd.flags)) {
    if (spec.required && flags[name] === undefined)
      throw usageError(`Missing required flag --${name}`);
  }

  return { flags, positionals };
}
