import { API_URL, ApiClient } from '../core/client';
import { DEFAULT_PROFILE, loadConfig, saveConfig } from '../core/config';
import { CliError, usageError } from '../core/errors';
import { readStdin } from '../core/io';
import { password } from '../ui/prompts';
import { isApiTokenFormat } from '../core/validate';
import { register } from '../registry';
import { browserLogin } from '../core/browser-login';
import { portalUrl } from '../core/portal';
import { isInteractive } from '../ui/spinner';
import type { Theme } from '../ui/theme';

const SCOPE_ORDER = (s: string) => {
  if (s === 'account:read') return 0;
  if (s.startsWith('vms:')) return 1;
  if (s.startsWith('servers:')) return 2;
  return 3;
};

function scopeRows(scopes: string[]): [string, string][] {
  const sorted = [...scopes].sort(
    (x, y) => SCOPE_ORDER(x) - SCOPE_ORDER(y) || x.localeCompare(y),
  );
  const width = process.stdout.columns ?? 80;
  const rows: [string, string][] = [];
  let line = '';
  for (const s of sorted) {
    const next = line ? `${line}, ${s}` : s;
    if (`  Scopes  ${next}`.length > Math.max(40, width) && line) {
      rows.push(['Scopes', `${line},`]);
      line = s;
    } else line = next;
  }
  rows.push(['Scopes', line]);
  return rows.map((r, i) => (i ? ['', r[1]] : r));
}

function formatExpiry(expiresAt: number | null | undefined): string {
  if (!expiresAt) return 'never';
  return new Date(expiresAt * 1000).toISOString();
}

export async function saveLogin(
  profile: string,
  token: string,
  via: 'browser' | 'token',
): Promise<{
  key_id: string;
  name: string;
  scopes: string[];
  expires_at: number | null;
  username: string | null;
}> {
  const client = new ApiClient({ token });
  const resp = await client.get(['token']);
  const info = resp?.token;
  if (!info || info.key_id === undefined)
    throw new CliError('server', 'Unexpected response from /v1/token');

  let username: string | null = null;
  try {
    const acct = await client.get(['account']);
    username = acct?.account?.username ?? null;
  } catch {}

  const config = loadConfig();
  config.profiles[profile] = { token, via };
  config.current = profile;
  saveConfig(config);
  return {
    key_id: info.key_id,
    name: info.name,
    scopes: info.scopes ?? [],
    expires_at: info.expires_at ?? null,
    username,
  };
}

export async function interactiveLogin(
  profile: string,
  theme: Theme,
  opts: { openBrowser?: boolean; interactive?: boolean } = {},
) {
  const result = await browserLogin({
    theme,
    openBrowser: opts.openBrowser ?? true,
    interactive: opts.interactive ?? isInteractive(),
  });
  return saveLogin(profile, result.token, 'browser');
}

const loginCommand = (path: string[]) =>
  register({
    path,
    summary: 'Log in through your browser',
    description:
      'Opens portal.bitqate.com, where you approve this computer. No token copying needed. Use --with-token or --token-stdin to log in with an API token instead (for CI and scripts).',
    args: [],
    flags: {
      'no-browser': {
        type: 'boolean',
        description: 'Print the sign-in link instead of opening a browser',
      },
      'with-token': {
        type: 'boolean',
        description: 'Paste an API token instead of using the browser',
      },
      'token-stdin': {
        type: 'boolean',
        description: 'Read an API token from stdin (for CI)',
      },
    },
    scope: null,
    interactive: true,
    examples: [
      'bitqate login',
      'bitqate login --no-browser',
      'bitqate login --with-token',
      'bitqate login --profile ci --token-stdin < token.txt',
    ],
    async run(ctx) {
      const profile = ctx.flags.profile ?? ctx.auth.profile ?? DEFAULT_PROFILE;

      let saved: Awaited<ReturnType<typeof saveLogin>>;
      if (ctx.flags['token-stdin'] || ctx.flags['with-token']) {
        let token: string;
        if (ctx.flags['token-stdin']) {
          token = (await readStdin()).trim();
        } else {
          if (!process.stdin.isTTY || !process.stderr.isTTY)
            throw usageError(
              'No terminal available; pass the token with --token-stdin instead.',
            );
          process.stderr.write(
            `Create a token at ${portalUrl('home')}/settings?tab=api\n`,
          );
          token = (
            await password({ message: 'API token' }, ctx.io.theme)
          ).trim();
        }
        if (!isApiTokenFormat(token))
          throw usageError(
            'That does not look like a BitQate token (bqat_<key_id>_<secret>).',
          );
        saved = await saveLogin(profile, token, 'token');
      } else {
        saved = await interactiveLogin(profile, ctx.io.theme, {
          openBrowser: !ctx.flags['no-browser'],
          interactive: ctx.io.interactive,
        });
      }

      const data = { profile, ...saved };
      return {
        data,
        render: (d, ui) => {
          const who = d.username
            ? ` as ${ui.theme.paint('strong', d.username)}`
            : '';
          const lines = [
            `${ui.theme.paint('success', ui.theme.glyph('check'))} Logged in${who}`,
          ];
          if (d.profile !== DEFAULT_PROFILE)
            lines.push(ui.theme.paint('muted', `  Profile ${d.profile}`));
          lines.push(
            '',
            ui.theme.paint('muted', 'Next steps'),
            `  bitqate deploy         ${ui.theme.paint('muted', 'Deploy this folder, an image, a database or a game server')}`,
            `  bitqate vms create     ${ui.theme.paint('muted', 'Create a VPS')}`,
            `  bitqate servers list   ${ui.theme.paint('muted', 'See what is running')}`,
          );
          return { lines };
        },
      };
    },
  });

loginCommand(['auth', 'login']);
loginCommand(['login']);

const logoutCommand = (path: string[]) =>
  register({
    path,
    summary: 'Log out and forget the stored token',
    args: [],
    flags: {},
    scope: null,
    examples: ['bitqate logout', 'bitqate logout --profile ci'],
    async run(ctx) {
      const profile = ctx.flags.profile ?? ctx.auth.profile ?? DEFAULT_PROFILE;
      const config = loadConfig();
      const entry = config.profiles[profile];
      if (!entry)
        throw new CliError(
          'usage',
          `You're not logged in${profile !== DEFAULT_PROFILE ? ` on profile '${profile}'` : ''}.`,
          {
            hint: 'Run bitqate login',
          },
        );
      let revoked = false;
      if (
        entry.via === 'browser' &&
        entry.token &&
        isApiTokenFormat(entry.token)
      ) {
        try {
          await new ApiClient({ token: entry.token, timeoutMs: 8000 }).delete([
            'token',
          ]);
          revoked = true;
        } catch {}
      }
      delete config.profiles[profile];
      if (config.current === profile) {
        config.current = Object.keys(config.profiles)[0] ?? undefined;
      }
      saveConfig(config);
      return {
        data: { profile, removed: true, revoked },
        render: (d, ui) => ({
          lines: [
            `${ui.theme.paint('success', ui.theme.glyph('check'))} Logged out${d.profile !== DEFAULT_PROFILE ? ` of profile '${d.profile}'` : ''}.`,
          ],
        }),
      };
    },
  });

logoutCommand(['auth', 'logout']);
logoutCommand(['logout']);

register({
  path: ['auth', 'status'],
  summary: 'Show which token and API URL are in effect',
  args: [],
  flags: {},
  scope: 'any',
  examples: ['bitqate auth status', 'bitqate auth status --json'],
  async run(ctx) {
    const resp = await ctx.api().get(['token']);
    const info = resp?.token ?? {};
    const data = {
      source: ctx.auth.source,
      profile: ctx.auth.profile,
      api_url: API_URL,
      key_id: info.key_id,
      name: info.name,
      scopes: info.scopes ?? [],
      expires_at: info.expires_at ?? null,
      last_used_at: info.last_used_at ?? null,
    };
    return {
      data,
      render: (d) => ({
        detail: {
          title: `Token "${d.name ?? ''}"`,
          fields: [
            ['Source', d.source],
            ['Profile', d.profile],
            ['API', d.api_url],
            ['Key ID', d.key_id],
            ...scopeRows(d.scopes ?? []),
            ['Expires', d.expires_at ? formatExpiry(d.expires_at) : 'never'],
          ],
        },
      }),
    };
  },
});

register({
  path: ['auth', 'list'],
  summary: 'List configured profiles',
  args: [],
  flags: {},
  scope: null,
  examples: ['bitqate auth list'],
  async run() {
    const config = loadConfig();
    const names = Object.keys(config.profiles);
    const data = names.map((name) => ({
      name,
      current: name === config.current,
    }));
    return {
      data,
      render: (rows: any[]) => {
        if (!rows.length)
          return { lines: ['Not logged in. Run bitqate login.'] };
        return {
          table: {
            columns: [{ title: 'Profile' }, { title: 'Current' }],
            rows: rows.map((r) => [r.name, r.current ? '*' : '']),
          },
        };
      },
    };
  },
});

register({
  path: ['auth', 'switch'],
  summary: 'Change the active profile',
  args: [{ name: 'profile', required: true, description: 'Profile name' }],
  flags: {},
  scope: null,
  examples: ['bitqate auth switch work'],
  async run(ctx) {
    const name = ctx.args[0];
    const config = loadConfig();
    if (!config.profiles[name]) throw usageError(`No such profile '${name}'`);
    config.current = name;
    saveConfig(config);
    return {
      data: { current: name },
      render: (d, ui) => ({
        lines: [
          `${ui.theme.paint('success', ui.theme.glyph('check'))} Switched to profile '${d.current}'.`,
        ],
      }),
    };
  },
});
