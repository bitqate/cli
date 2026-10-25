import { API_URL, ApiClient } from '../core/client';
import {
  DEFAULT_PROFILE,
  loadConfig,
  saveConfig,
} from '../core/config';
import { CliError, usageError } from '../core/errors';
import { readStdin } from '../core/io';
import { password } from '../ui/prompts';
import { isApiTokenFormat } from '../core/validate';
import { register } from '../registry';

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

register({
  path: ['auth', 'login'],
  summary: 'Store an API token in a config profile',
  args: [],
  flags: {
    'token-stdin': {
      type: 'boolean',
      description: 'Read the token from stdin instead of a prompt',
    },
  },
  scope: null,
  interactive: true,
  examples: [
    'bitqate auth login',
    'bitqate auth login --token-stdin < token.txt',
    'bitqate auth login --profile ci --token-stdin < token.txt',
  ],
  async run(ctx) {
    const profile = ctx.flags.profile ?? ctx.auth.profile ?? DEFAULT_PROFILE;

    let token: string;
    if (ctx.flags['token-stdin']) {
      token = (await readStdin()).trim();
    } else {
      if (!process.stdin.isTTY || !process.stderr.isTTY)
        throw usageError(
          'No terminal available; pass the token with --token-stdin instead.',
        );
      process.stderr.write(
        'Create a token at https://portal.bitqate.com/settings?tab=api\nGrant only the scopes you need and set an expiry for automation.\n',
      );
      token = (await password({ message: 'API token' }, ctx.io.theme)).trim();
    }
    if (!isApiTokenFormat(token))
      throw usageError(
        'Malformed token: expected the format bqat_<key_id>_<secret>.',
      );

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
    config.profiles[profile] = { token };
    config.current = profile;
    saveConfig(config);

    const data = {
      profile,
      username,
      key_id: info.key_id,
      name: info.name,
      scopes: info.scopes,
      expires_at: info.expires_at,
    };
    return {
      data,
      render: (d, ui) => {
        const who = d.username ? ` as ${d.username}` : '';
        const scopeCount = (d.scopes ?? []).length;
        return {
          lines: [
            `${ui.theme.paint('success', ui.theme.glyph('check'))} Logged in${who} · token "${d.name}" · ${scopeCount} scope${scopeCount === 1 ? '' : 's'} · profile ${d.profile}`,
          ],
        };
      },
    };
  },
});

register({
  path: ['auth', 'logout'],
  summary: 'Remove a stored API token profile',
  args: [],
  flags: {},
  scope: null,
  examples: ['bitqate auth logout', 'bitqate auth logout --profile ci'],
  async run(ctx) {
    const profile = ctx.flags.profile ?? ctx.auth.profile ?? DEFAULT_PROFILE;
    const config = loadConfig();
    if (!config.profiles[profile])
      throw usageError(`No such profile '${profile}'`);
    delete config.profiles[profile];
    if (config.current === profile) {
      config.current = Object.keys(config.profiles)[0] ?? undefined;
    }
    saveConfig(config);
    return {
      data: { profile, removed: true },
      render: (d, ui) => ({
        lines: [
          `${ui.theme.paint('success', ui.theme.glyph('check'))} Removed profile '${d.profile}'.`,
        ],
      }),
    };
  },
});

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
          return { lines: ['No profiles. Run `bitqate auth login`.'] };
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
