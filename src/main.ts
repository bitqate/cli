import {
  destructiveGate,
  parseCommandLine,
  splitGlobalFlags,
  suggest,
} from './core/args';
import { ApiClient, DryRunRequest } from './core/client';
import { assertTokenOrigin, loadConfig, resolveAuth } from './core/config';
import { CliError, usageError } from './core/errors';
import {
  isRenderable,
  printError,
  printJson,
  printQuiet,
  printRenderable,
} from './core/output';
import { confirmResourceId } from './core/prompt';
import { encodePathSegment, isApiTokenFormat } from './core/validate';
import { commands, matchPath } from './registry';
import { commandHelp, globalHelp } from './commands/meta';
import pkg from '../package.json';

import './commands/auth';
import './commands/account';
import './commands/vms';
import './commands/servers';
import './commands/prices';
import './commands/meta';

function commandNames(): string[] {
  return commands.map((c) => c.path.join(' '));
}

const CONFIRM_HINT = 'pass --yes to confirm';

async function confirmDestructive(
  id: string,
  io: { json: boolean; yes: boolean },
): Promise<void> {
  const gate = destructiveGate({
    json: io.json,
    yes: io.yes,
    tty: !!process.stdin.isTTY,
  });
  if (gate === 'proceed') return;
  if (gate === 'require-yes')
    throw new CliError('usage', 'This action is destructive.', {
      hint: CONFIRM_HINT,
    });
  if (!(await confirmResourceId(id)))
    throw usageError('Confirmation did not match; aborted.');
}

export async function main(argv: string[]): Promise<number> {
  const { flagArgv, restArgv } = splitGlobalFlags(argv);

  const leading: string[] = [];
  let i = 0;
  for (; i < restArgv.length; i++) {
    if (restArgv[i].startsWith('-')) break;
    leading.push(restArgv[i]);
  }

  if (!leading.length) {
    if (restArgv.includes('version') || flagArgv.includes('--version')) {
      process.stdout.write(`bitqate ${pkg.version}\n`);
      return 0;
    }
    process.stdout.write(`${globalHelp()}\n`);
    return 0;
  }

  const { command, consumed } = matchPath(leading);
  if (!command) {
    const guess = suggest(leading.join(' '), commandNames());
    throw usageError(
      `Unknown command '${leading.join(' ')}'` +
        (guess ? `. Did you mean 'bitqate ${guess}'?` : ''),
    );
  }

  const { flags, positionals } = parseCommandLine(
    command,
    restArgv.slice(consumed).concat(flagArgv),
  );

  if (flags.help) {
    process.stdout.write(`${commandHelp(command)}\n`);
    return 0;
  }

  if (command.scope !== null && positionals.length > 0) {
    for (const pos of positionals) encodePathSegment(pos);
  }

  const config = loadConfig();
  const auth = resolveAuth(config, {
    profile: flags.profile,
    apiUrl: flags['api-url'],
  });

  const io = {
    json: !!flags.json || process.env.BITQATE_OUTPUT === 'json',
    quiet: !!flags.quiet,
    yes: !!flags.yes,
    color:
      !flags['no-color'] && !process.env.NO_COLOR && !!process.stdout.isTTY,
    verbose: !!flags.verbose,
  };

  let built: ApiClient | undefined;
  const api = (): ApiClient => {
    if (!built) {
      if (!auth.token)
        throw new CliError(
          'unauthenticated',
          'No API token. Run `bitqate auth login` or set BITQATE_TOKEN.',
        );
      if (!isApiTokenFormat(auth.token))
        throw new CliError(
          'unauthenticated',
          'The configured token is malformed. Expected bqat_<key_id>_<secret>.',
        );
      assertTokenOrigin(auth);
      built = new ApiClient({
        apiUrl: auth.apiUrl,
        token: auth.token,
        verbose: io.verbose,
        dryRun: !!flags['dry-run'],
      });
    }
    return built;
  };

  if (command.destructive && !command.confirmInside && !flags['dry-run']) {
    await confirmDestructive(positionals[0], io);
  }

  try {
    const result = await command.run({
      api,
      config,
      auth,
      args: positionals,
      flags,
      io,
    });
    if (io.json) {
      const data =
        result.data &&
        typeof result.data === 'object' &&
        !Array.isArray(result.data)
          ? Object.fromEntries(
              Object.entries(result.data).filter(([k]) => k !== 'success'),
            )
          : result.data;
      printJson(data);
    } else if (io.quiet) {
      printQuiet(result.data);
    } else if (result.render) {
      const rendered = result.render(result.data, io.color);
      if (isRenderable(rendered)) printRenderable(rendered);
    } else {
      printJson(result.data);
    }
    return 0;
  } catch (err) {
    if (err instanceof DryRunRequest) {
      const lines = [`${err.method} ${err.url}`];
      if (err.body !== null && err.body !== undefined)
        lines.push(JSON.stringify(err.body, null, 2));
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    throw err;
  }
}

export function wantsJson(argv: string[]): boolean {
  return argv.includes('--json') || process.env.BITQATE_OUTPUT === 'json';
}

export async function run(argv: string[]): Promise<number> {
  const json = wantsJson(argv);
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof CliError) {
      printError(err, json);
      return err.exitCode;
    }
    printError(
      new CliError('server', err instanceof Error ? err.message : String(err)),
      json,
    );
    return 1;
  }
}
