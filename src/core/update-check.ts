import fs from 'fs';
import path from 'path';
import { configDir } from './config';
import { API_URL } from './client';
import type { Theme } from '../ui/theme';

export interface UpdateCheckCache {
  checkedAt: number;
  latest: string | null;
  warnedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SEMVER = /^\d+\.\d+\.\d+$/;

export function isNewer(latest: string, current: string): boolean {
  if (!SEMVER.test(latest) || !SEMVER.test(current)) return false;
  const [a, b, c] = latest.split('.').map(Number);
  const [x, y, z] = current.split('.').map(Number);
  return a > x || (a === x && (b > y || (b === y && c > z)));
}

export function updateCommand(
  execPath: string,
  isCompiledBun: boolean,
  fsExists: (p: string) => boolean,
): string {
  if (!isCompiledBun) return 'npm i -g @bitqate/cli@latest';
  const p = execPath.replace(/\\/g, '/');
  if (p.includes('/uv/tools/')) return 'uv tool upgrade bitqate';
  if (p.includes('/.cache/uv/')) return 'uvx bitqate@latest';
  if (p.includes('pipx')) return 'pipx upgrade bitqate';
  if (
    p.includes('site-packages') ||
    fsExists(path.resolve(path.dirname(execPath), '..', '..', 'pyvenv.cfg'))
  )
    return 'pip install -U bitqate';
  return 'download the latest release from https://github.com/bitqate/cli/releases/latest';
}

export function isCompiledBinary(
  argv1: string | undefined = process.argv[1],
  bunVersion: string | undefined = process.versions.bun,
): boolean {
  if (!bunVersion || !argv1) return false;
  return argv1.startsWith('/$bunfs/') || argv1.includes('~BUN');
}

export function currentUpdateCommand(): string {
  return updateCommand(process.execPath, isCompiledBinary(), fs.existsSync);
}

export function updateCheckDisabled(opts: {
  env: NodeJS.ProcessEnv;
  stderrTty: boolean;
  json: boolean;
  quiet: boolean;
  commandPath: string[];
}): boolean {
  return (
    !!opts.env.BITQATE_NO_UPDATE_CHECK ||
    !!opts.env.CI ||
    !opts.stderrTty ||
    opts.json ||
    opts.quiet ||
    opts.commandPath[0] === 'completion'
  );
}

const cachePath = () => path.join(configDir(), 'update-check.json');

export function readUpdateCheckCache(): UpdateCheckCache | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(c: UpdateCheckCache) {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(c), { mode: 0o600 });
  } catch {}
}

export function startUpdateCheck(
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<string | null> | null {
  const cached = readUpdateCheckCache();
  if (cached && now - cached.checkedAt < DAY_MS) return null;
  writeCache({
    checkedAt: now,
    latest: cached?.latest ?? null,
    warnedAt: cached?.warnedAt ?? 0,
  });
  return (async () => {
    try {
      const resp = await fetchImpl(`${API_URL}/public/cli/version`, {
        signal: AbortSignal.timeout(1500),
      });
      const data = (await resp.json()) as { latest?: unknown };
      const latest =
        typeof data?.latest === 'string' && SEMVER.test(data.latest)
          ? data.latest
          : null;
      if (latest) {
        const fresh = readUpdateCheckCache();
        writeCache({
          checkedAt: fresh?.checkedAt ?? now,
          latest,
          warnedAt: fresh?.warnedAt ?? 0,
        });
      }
      return latest;
    } catch {
      return null;
    }
  })();
}

export async function finishUpdateCheck(opts: {
  pending: Promise<string | null> | null;
  current: string;
  theme: Theme;
  waitMs?: number;
  now?: number;
  write?: (s: string) => void;
}): Promise<void> {
  const { pending, current, theme } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const got = pending
    ? await Promise.race([
        pending,
        new Promise<null>((r) => {
          timer = setTimeout(() => r(null), opts.waitMs ?? 300);
        }),
      ])
    : null;
  if (timer) clearTimeout(timer);
  const cached = readUpdateCheckCache();
  const latest = got ?? cached?.latest ?? null;
  if (!latest || !isNewer(latest, current)) return;
  const now = opts.now ?? Date.now();
  if (cached?.warnedAt && now - cached.warnedAt < DAY_MS) return;
  (opts.write ?? ((s: string) => process.stderr.write(s)))(
    `${theme.paint('warning', theme.glyph('bang'))} bitqate ${latest} is available (you have ${current}). Update: ${currentUpdateCommand()}\n`,
  );
  writeCache({
    checkedAt: cached?.checkedAt ?? now,
    latest,
    warnedAt: now,
  });
}
