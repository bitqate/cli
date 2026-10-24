import { ApiClient } from '../core/client';
import {
  DEFAULT_PROFILE,
  loadConfig,
  resolveAuth,
  saveConfig,
} from '../core/config';
import { CliError, usageError } from '../core/errors';
import { kvLines } from '../core/output';
import { readHidden, readStdin } from '../core/prompt';
import { isApiTokenFormat, validateApiUrl } from '../core/validate';
import { register } from '../registry';

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
      description: 'Read the token from stdin instead of a hidden prompt',
    },
  },
  scope: null,
  examples: [
    'bitqate auth login',
    'bitqate auth login --token-stdin < token.txt',
    'bitqate auth login --profile ci --api-url http://127.0.0.1:3000 --token-stdin',
  ],
  async run(ctx) {
    const profile = ctx.flags.profile ?? ctx.auth.profile ?? DEFAULT_PROFILE;
    const apiUrl = ctx.flags['api-url'] ?? ctx.auth.apiUrl;
    const baseUrl = validateApiUrl(apiUrl);

    let token: string;
    if (ctx.flags['token-stdin']) {
      token = (await readStdin()).trim();
    } else {
      token = (await readHidden('API token: ')).trim();
    }
    if (!isApiTokenFormat(token))
      throw usageError(
        'Malformed token: expected the format bqat_<key_id>_<secret>.',
      );

    const client = new ApiClient({ apiUrl: baseUrl, token });
    const resp = await client.get(['token']);
    const info = resp?.token;
    if (!info || info.key_id === undefined)
      throw new CliError('server', 'Unexpected response from /v1/token');

    const config = loadConfig();
    config.profiles[profile] = { api_url: baseUrl, token };
    config.current = profile;
    saveConfig(config);

    const data = {
      profile,
      api_url: baseUrl,
      key_id: info.key_id,
      name: info.name,
      scopes: info.scopes,
      expires_at: info.expires_at,
    };
    return {
      data,
      render: (d) => ({
        lines: [
          `Saved token to profile '${d.profile}'.`,
          ...kvLines({
            key_id: d.key_id,
            name: d.name,
            scopes: (d.scopes ?? []).join(', '),
            expires: formatExpiry(d.expires_at),
          }),
        ],
      }),
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
      render: (d) => ({ lines: [`Removed profile '${d.profile}'.`] }),
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
      api_url: ctx.auth.apiUrl,
      key_id: info.key_id,
      name: info.name,
      scopes: info.scopes ?? [],
      expires_at: info.expires_at ?? null,
      last_used_at: info.last_used_at ?? null,
    };
    return {
      data,
      render: (d) => ({
        lines: kvLines({
          source: d.source,
          profile: d.profile,
          api_url: d.api_url,
          key_id: d.key_id,
          name: d.name,
          scopes: (d.scopes ?? []).join(', '),
          expires: formatExpiry(d.expires_at),
        }),
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
      api_url: config.profiles[name].api_url ?? null,
      current: name === config.current,
    }));
    return {
      data,
      render: (rows) => ({
        table: {
          head: ['PROFILE', 'API URL', 'CURRENT'],
          rows: rows.map((r: any) => [
            r.name,
            r.api_url ?? '',
            r.current ? '*' : '',
          ]),
        },
      }),
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
      render: (d) => ({ lines: [`Switched to profile '${d.current}'.`] }),
    };
  },
});
