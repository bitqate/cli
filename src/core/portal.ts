import { spawn } from 'node:child_process';
import { usageError } from './errors';
import { validateApiUrl } from './validate';

const PORTAL_URL = 'https://portal.bitqate.com';
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.:/\[\]-]+$/;

export function portalOrigin(): string {
  const override = process.env.BITQATE_PORTAL_URL;
  return override ? validateApiUrl(override) : PORTAL_URL;
}

export function portalUrl(kind: 'vm' | 'server' | 'home', id?: string): string {
  const base = portalOrigin();
  if (kind === 'home') return base;
  return `${base}/${kind}/${id}`;
}

export function launcher(): { cmd: string; args: (url: string) => string[] } {
  const isWsl = !!(
    process.env.WSL_DISTRO_NAME ||
    (process.platform === 'linux' &&
      /microsoft/i.test(process.env.WSL_INTEROP ?? ''))
  );
  if (process.platform === 'darwin') return { cmd: 'open', args: (u) => [u] };
  if (process.platform === 'win32')
    return { cmd: 'cmd', args: (u) => ['/c', 'start', '', u] };
  if (isWsl) return { cmd: 'wslview', args: (u) => [u] };
  return { cmd: 'xdg-open', args: (u) => [u] };
}

function trySpawn(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code ?? 0));
    child.unref();
  });
}

export async function openUrl(url: string): Promise<number> {
  if (!SAFE_URL.test(url)) throw usageError(`Refusing to open '${url}'`);
  const l = launcher();
  let code = await trySpawn(l.cmd, l.args(url));
  if (code === null && l.cmd === 'wslview')
    code = await trySpawn('xdg-open', [url]);
  if (code === null || code !== 0) {
    process.stderr.write(`Open this URL in your browser: ${url}\n`);
    return 0;
  }
  return code;
}
