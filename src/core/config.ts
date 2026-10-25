import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ProfileEntry {
  token?: string;
}

export interface CliConfig {
  version: 1;
  current?: string;
  profiles: Record<string, ProfileEntry>;
}

export const DEFAULT_PROFILE = 'default';

export function configDir(): string {
  if (process.env.BITQATE_CONFIG_DIR) return process.env.BITQATE_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'bitqate');
  return join(homedir(), '.config', 'bitqate');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

const EMPTY_CONFIG: CliConfig = { version: 1, profiles: {} };

export function loadConfig(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...EMPTY_CONFIG, profiles: {} };
  warnIfWorldReadable(path);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object')
      return { ...EMPTY_CONFIG, profiles: {} };
    return {
      version: 1,
      current: typeof parsed.current === 'string' ? parsed.current : undefined,
      profiles:
        parsed.profiles && typeof parsed.profiles === 'object'
          ? parsed.profiles
          : {},
    };
  } catch {
    return { ...EMPTY_CONFIG, profiles: {} };
  }
}

function warnIfWorldReadable(path: string): void {
  if (process.platform === 'win32') return;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      process.stderr.write(
        `Warning: ${path} is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it.\n`,
      );
    }
  } catch {}
}

export function saveConfig(config: CliConfig): void {
  const dir = configDir();
  const path = configPath();
  if (process.platform !== 'win32') {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {}
    warnIfWorldReadable(path);
  } else {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = join(dir, `.config.json.${process.pid}.tmp`);
  const data = JSON.stringify(config, null, 2) + '\n';
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export interface ResolvedAuth {
  token: string | null;
  profile: string;
  source: 'env' | 'profile' | 'none';
}

export function resolveAuth(
  config: CliConfig,
  opts: { profile?: string },
): ResolvedAuth {
  const profile =
    opts.profile ??
    process.env.BITQATE_PROFILE ??
    config.current ??
    DEFAULT_PROFILE;
  const entry = config.profiles[profile];
  const envToken = process.env.BITQATE_TOKEN;
  const token = envToken ?? entry?.token ?? null;
  const source = envToken ? 'env' : entry?.token ? 'profile' : 'none';
  return { token, profile, source };
}
