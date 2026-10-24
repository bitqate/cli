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
  errorHint,
  isRenderable,
  printError,
  printJson,
  printQuiet,
  printRenderable,
} from './core/output';
import { encodePathSegment, isApiTokenFormat } from './core/validate';
import { commands, findGroup, groups, matchPath } from './registry';
import { commandHelp, groupHelp, rootHelp } from './ui/help';
import { isInteractive } from './ui/spinner';
import { money } from './ui/format';
import { detectLevel, makeTheme, useUnicode } from './ui/theme';
import pkg from '../package.json';

import './commands/auth';
import './commands/account';
import './commands/vms';
import './commands/servers';
import './commands/prices';
import './commands/meta';
import './commands/tools';

function commandNames(): string[] {
  return commands.map((c) => c.path.join(' '));
}

const CONFIRM_HINT = 'pass --yes to confirm';

async function confirmDestructive(
  id: string,
  io: { json: boolean; yes: boolean; interactive: boolean },
): Promise<void> {
  const gate = destructiveGate({
    json: io.json,
    yes: io.yes,
    tty: io.interactive,
  });
  if (gate === 'proceed') return;
  if (gate === 'require-yes')
    throw new CliError('usage', 'This action is destructive.', {
      hint: CONFIRM_HINT,
    });
  const { text } = await import('./ui/prompts');
    const typed = await text(
      { message: `Type '${id}' to confirm` },
      makeTheme(detectLevel(process.stderr), useUnicode()),
    );
    if (typed !== id) throw usageError('Confirmation did not match; aborted.');
}

async function rootScreen(io: {
  interactive: boolean;
  json: boolean;
}): Promise<number> {
  const theme = makeTheme(detectLevel(process.stdout), useUnicode());
  const width = process.stdout.columns ?? 80;
  const title = `${theme.paint('strong', 'bitqate')}  ${theme.paint('muted', 'Deployments you can trust.')}`;
  const plain = 'bitqate  Deployments you can trust.';
  const ver = `v${pkg.version}`;
  const pad = Math.max(1, width - plain.length - ver.length);
  process.stdout.write(
    `${title}${' '.repeat(pad)}${theme.paint('muted', ver)}\n\n`,
  );

  if (process.stdout.isTTY) {
    const config = loadConfig();
    const auth = resolveAuth(config, {});
    if (!auth.token || !isApiTokenFormat(auth.token)) {
      process.stdout.write(
        `${theme.paint('muted', 'Not logged in. Run bitqate auth login to get started.')}\n\n`,
      );
    } else {
      try {
        assertTokenOrigin(auth);
        const client = new ApiClient({
          apiUrl: auth.apiUrl,
          token: auth.token,
        });
        const grab = <T>(p: Promise<T>) =>
          Promise.race<T | null>([
            p,
            new Promise<null>((r) => setTimeout(() => r(null), 3000)),
          ]).catch(() => null);
        const [account, vms, servers] = await Promise.all([
          grab(client.get(['account'])),
          grab(client.get(['vms'])),
          grab(client.get(['servers'])),
        ]);
        if (account?.account) {
          const a = account.account;
          const left = `${a.username ?? ''} · ${a.email ?? ''}`;
          const right = `Balance ${money(a.balance ?? 0)}`;
          const gap = Math.max(1, 32 - left.length);
          process.stdout.write(
            `  ${theme.paint('strong', left)}${' '.repeat(gap)}${right}\n`,
          );
        }
        const stateLine = (
          label: string,
          items: any[] | null,
          word: string,
        ) => {
          if (!items) return;
          const active = items.filter((x) =>
            ['running', 'online', 'active'].includes(x.status),
          ).length;
          const tone = active ? 'success' : 'muted';
          process.stdout.write(
            `  ${theme.paint('muted', label.padEnd(9))} ${theme.paint(tone, `${active} ${word}`)}\n`,
          );
        };
        stateLine('VMs', vms?.vms ?? null, 'running');
        stateLine('Servers', servers?.servers ?? null, 'online');
        process.stdout.write('\n');
      } catch {
        process.stdout.write('\n');
      }
    }
  }
  process.stdout.write(`${rootHelp(theme)}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const { flagArgv, restArgv } = splitGlobalFlags(argv);
  const theme = makeTheme(
    flagArgv.includes('--no-color') ? 0 : detectLevel(process.stderr),
    useUnicode(),
  );

  const leading: string[] = [];
  let i = 0;
  for (; i < restArgv.length; i++) {
    if (restArgv[i].startsWith('-')) break;
    leading.push(restArgv[i]);
  }

  const ioFlags = {
    json: flagArgv.includes('--json') || process.env.BITQATE_OUTPUT === 'json',
    interactive: isInteractive(),
  };

  if (!leading.length) {
    if (restArgv.includes('version') || flagArgv.includes('--version')) {
      process.stdout.write(`bitqate ${pkg.version}\n`);
      return 0;
    }
    return rootScreen(ioFlags);
  }

  const { command, consumed } = matchPath(leading);
  if (!command) {
    if (findGroup(leading) || subcommandsExist(leading)) {
      process.stdout.write(`${groupHelp(leading, theme)}\n`);
      return 0;
    }
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
    process.stdout.write(`${commandHelp(command, theme)}\n`);
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
    json: ioFlags.json,
    quiet: !!flags.quiet,
    yes: !!flags.yes,
    interactive: ioFlags.interactive,
    theme,
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
      const rendered = result.render(result.data, io);
      if (isRenderable(rendered))
        printRenderable(rendered, { ...io, tty: !!process.stdout.isTTY });
    } else {
      printJson(result.data);
    }
    return 0;
  } catch (err) {
    if (err instanceof DryRunRequest) {
      if (ioFlags.interactive) process.stderr.write('\n');
      const lines = [`${err.method} ${err.url}`];
      if (err.body !== null && err.body !== undefined)
        lines.push(JSON.stringify(err.body, null, 2));
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    throw err;
  }
}

function subcommandsExist(tokens: string[]): boolean {
  return commands.some(
    (c) =>
      c.path.length > tokens.length && tokens.every((t, i) => c.path[i] === t),
  );
}

export function wantsJson(argv: string[]): boolean {
  return argv.includes('--json') || process.env.BITQATE_OUTPUT === 'json';
}

export async function run(argv: string[]): Promise<number> {
  const json = wantsJson(argv);
  try {
    return await main(argv);
  } catch (err) {
    const theme = makeTheme(detectLevel(process.stderr), useUnicode());
    if (err instanceof CliError) {
      printError(err, json, theme);
      return err.exitCode;
    }
    printError(
      new CliError('server', err instanceof Error ? err.message : String(err)),
      json,
      theme,
    );
    return 1;
  }
}
