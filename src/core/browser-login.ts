import { hostname } from 'node:os';
import { publicRequest } from './client';
import { CliError } from './errors';
import { openUrl, portalUrl } from './portal';
import { task } from '../ui/spinner';
import type { Theme } from '../ui/theme';
import { isApiTokenFormat } from './validate';

const USER_CODE_RE = /^[A-Z]{4}-[A-Z]{4}$/;

export interface BrowserLoginResult {
  token: string;
  username: string | null;
  expires_at: number | null;
}

export function clientName(): string {
  const host = hostname()
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 32);
  const os =
    process.platform === 'darwin'
      ? 'macOS'
      : process.platform === 'win32'
        ? 'Windows'
        : process.platform === 'linux'
          ? 'Linux'
          : process.platform;
  return host ? `${host} (${os})` : `BitQate CLI (${os})`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function browserLogin(opts: {
  theme: Theme;
  openBrowser: boolean;
  interactive: boolean;
  fetchImpl?: typeof fetch;
}): Promise<BrowserLoginResult> {
  const { theme } = opts;
  const start = await task(
    'Starting sign-in',
    theme,
    () =>
      publicRequest('POST', '/auth/cli/start', {
        body: { client_name: clientName() },
        fetchImpl: opts.fetchImpl,
      }).catch((err) => {
        if (err instanceof CliError && err.code === 'not_found')
          throw new CliError(
            'server',
            'Browser sign-in is not available right now.',
            {
              hint: 'Log in with an API token instead: bitqate login --with-token',
            },
          );
        throw err;
      }),
    { interactive: opts.interactive },
  );
  const userCode = String(start?.user_code ?? '');
  const deviceCode = String(start?.device_code ?? '');
  if (!USER_CODE_RE.test(userCode) || !deviceCode)
    throw new CliError('server', 'Unexpected response when starting sign-in');
  const url = portalUrl('cli', userCode);
  const expiresAt =
    Date.now() + Math.max(60, Number(start.expires_in) || 600) * 1000;
  const interval =
    Math.min(10, Math.max(1, Number(start.interval) || 2)) * 1000;

  const out = process.stderr;
  out.write(
    `\n  ${theme.paint('muted', 'Your one-time code')}  ${theme.paint('strong', userCode)}\n\n`,
  );
  let opened = false;
  if (opts.openBrowser) {
    out.write(
      `  Opening ${theme.paint('strong', 'portal.bitqate.com')} in your browser${theme.glyph('ellipsis')}\n`,
    );
    opened = (await openUrl(url, { quietFallback: true })) === 0;
  }
  out.write(
    opened
      ? `  ${theme.paint('muted', `If nothing opened, visit ${url}`)}\n\n`
      : `  Open this link on any device and approve the sign-in:\n  ${theme.paint('progress', url)}\n\n`,
  );

  return task(
    'Waiting for you to approve in the browser',
    theme,
    async (t) => {
      for (;;) {
        if (Date.now() > expiresAt)
          throw new CliError(
            'timeout',
            'The sign-in code expired before it was approved.',
            { hint: 'Run bitqate login to get a new code' },
          );
        await sleep(interval);
        let resp: any;
        try {
          resp = await publicRequest('POST', '/auth/cli/poll', {
            body: { device_code: deviceCode },
            fetchImpl: opts.fetchImpl,
          });
        } catch (err) {
          if (
            err instanceof CliError &&
            (err.code === 'network' || err.code === 'rate_limited')
          ) {
            t.update('reconnecting');
            continue;
          }
          throw err;
        }
        const status = resp?.status;
        if (status === 'pending') continue;
        if (status === 'denied')
          throw new CliError('cancelled', 'Sign-in was denied in the browser.');
        if (status === 'expired')
          throw new CliError(
            'timeout',
            'The sign-in code expired before it was approved.',
            { hint: 'Run bitqate login to get a new code' },
          );
        if (status === 'approved' && isApiTokenFormat(String(resp.token ?? '')))
          return {
            token: String(resp.token),
            username: typeof resp.username === 'string' ? resp.username : null,
            expires_at:
              typeof resp.expires_at === 'number' ? resp.expires_at : null,
          };
        throw new CliError(
          'server',
          'Unexpected response while waiting for sign-in',
        );
      }
    },
    { interactive: opts.interactive },
  );
}
