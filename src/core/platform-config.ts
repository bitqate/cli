import fs from 'fs';
import path from 'path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

// Reads a folder for platform config files (fly.toml, render.yaml,
// railway.json/toml, Procfile) and normalizes them into the settings
// `bitqate deploy` can apply when creating a server.

export interface ImportedConfig {
  source:
    | 'fly.toml'
    | 'render.yaml'
    | 'railway.json'
    | 'railway.toml'
    | 'Procfile';
  appPort?: number;
  dataPath?: string;
  healthCheck?: { type: 'http'; path: string };
  startCommand?: string;
  dockerfilePath?: string;
  env: Record<string, string>;
  needsManualEnv: string[];
  warnings: string[];
}

const FILES: Array<ImportedConfig['source']> = [
  'fly.toml',
  'render.yaml',
  'railway.json',
  'railway.toml',
  'Procfile',
];

export function detectPlatformConfig(dir: string): ImportedConfig | null {
  const found = FILES.filter((f) => fs.existsSync(path.join(dir, f)));
  if (!found.length) return null;
  const cfg = parse(found[0], dir);
  if (cfg && found.length > 1) {
    cfg.warnings.push(
      `Also found ${found.slice(1).join(', ')} — only ${found[0]} is used`,
    );
  }
  return cfg;
}

function parse(source: string, dir: string): ImportedConfig | null {
  try {
    switch (source) {
      case 'fly.toml':
        return parseFly(fs.readFileSync(path.join(dir, source), 'utf-8'));
      case 'render.yaml':
        return parseRender(fs.readFileSync(path.join(dir, source), 'utf-8'));
      case 'railway.json':
        return parseRailway(
          JSON.parse(fs.readFileSync(path.join(dir, source), 'utf-8')),
        );
      case 'railway.toml':
        return parseRailway(
          parseToml(fs.readFileSync(path.join(dir, source), 'utf-8')),
        );
      case 'Procfile':
        return parseProcfile(fs.readFileSync(path.join(dir, source), 'utf-8'));
    }
  } catch {
    return null;
  }
  return null;
}

function base(source: ImportedConfig['source']): ImportedConfig {
  return { source, env: {}, needsManualEnv: [], warnings: [] };
}

function parseFly(text: string): ImportedConfig {
  const doc: any = parseToml(text);
  const cfg = base('fly.toml');
  const hs = doc.http_service;
  cfg.appPort =
    num(hs?.internal_port) ??
    (Array.isArray(doc.services)
      ? num(doc.services[0]?.internal_port)
      : undefined);
  const checks = [
    ...(Array.isArray(hs?.checks) ? hs.checks : []),
    ...(doc.checks && typeof doc.checks === 'object'
      ? Object.values(doc.checks)
      : []),
  ];
  const httpCheck = checks.find(
    (c: any) => c && (c.type === 'http' || c.path) && c.path,
  );
  if (httpCheck)
    cfg.healthCheck = { type: 'http', path: String(httpCheck.path) };
  const mounts = Array.isArray(doc.mounts) ? doc.mounts[0] : doc.mounts;
  if (mounts?.destination) cfg.dataPath = String(mounts.destination);
  if (doc.env && typeof doc.env === 'object') {
    for (const [k, v] of Object.entries(doc.env)) cfg.env[k] = String(v);
  }
  if (doc.build?.dockerfile) cfg.dockerfilePath = String(doc.build.dockerfile);
  const procs = doc.processes;
  cfg.startCommand =
    str(procs?.app) ?? str(procs?.web) ?? str(doc.experimental?.cmd);
  cfg.warnings.push(
    "Secrets set with `fly secrets` can't be read — set them again here.",
  );
  return cfg;
}

function parseRender(text: string): ImportedConfig {
  const doc: any = parseYaml(text);
  const cfg = base('render.yaml');
  const services = Array.isArray(doc?.services) ? doc.services : [];
  const webs = services.filter(
    (s: any) => !s.type || s.type === 'web' || s.type === 'web_service',
  );
  const svc = webs[0];
  if (!svc) return cfg;
  if (webs.length > 1) {
    cfg.warnings.push(
      `render.yaml defines ${webs.length} web services; only "${svc.name ?? 'the first'}" is imported`,
    );
  }
  cfg.dockerfilePath = str(svc.dockerfilePath);
  cfg.startCommand = str(svc.startCommand);
  const hc = str(svc.healthCheckPath);
  if (hc) cfg.healthCheck = { type: 'http', path: hc };
  if (svc.disk?.mountPath) cfg.dataPath = String(svc.disk.mountPath);
  for (const v of svc.envVars ?? []) {
    if (v?.value !== undefined && v.value !== null) {
      cfg.env[String(v.key)] = String(v.value);
    } else if (
      v?.key &&
      (v.sync === false ||
        v.generateValue ||
        v.fromDatabase ||
        v.fromService ||
        v.fromGroup)
    ) {
      cfg.needsManualEnv.push(String(v.key));
    }
  }
  // Render injects PORT (default 10000); BitQate does too — no appPort.
  return cfg;
}

function parseRailway(doc: any): ImportedConfig {
  const cfg = base('railway.json');
  cfg.dockerfilePath = str(doc?.build?.dockerfilePath);
  cfg.startCommand = str(doc?.deploy?.startCommand);
  const hc = str(doc?.deploy?.healthcheckPath);
  if (hc) cfg.healthCheck = { type: 'http', path: hc };
  // Railway injects PORT as well — no appPort.
  return cfg;
}

function parseProcfile(text: string): ImportedConfig {
  const cfg = base('Procfile');
  for (const line of text.split(/\r?\n/)) {
    const m = /^web\s*:\s*(.+)$/.exec(line.trim());
    if (m) {
      cfg.startCommand = m[1].trim();
      break;
    }
  }
  return cfg;
}

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

// Compact human summary of an imported config. When `oneLine`, returns a
// single parenthetical string for the non-TTY notice.
export function platformSummary(
  c: ImportedConfig,
  oneLine = false,
): string[] | string {
  const parts: Array<[string, string | undefined]> = [
    ['File', c.source],
    ['App port', c.appPort !== undefined ? String(c.appPort) : undefined],
    ['Data path', c.dataPath],
    ['Health check', c.healthCheck?.path],
    ['Start command', c.startCommand],
    [
      'Env vars',
      Object.keys(c.env).length
        ? `${Object.keys(c.env).length} var(s)`
        : undefined,
    ],
    [
      'Set later',
      c.needsManualEnv.length ? c.needsManualEnv.join(', ') : undefined,
    ],
  ];
  const seen = parts.filter(([, v]) => v !== undefined);
  if (oneLine) {
    return seen
      .filter(([k]) => k !== 'File')
      .map(([k, v]) => `${k!.toLowerCase()} ${v}`)
      .join(', ');
  }
  const lines = seen.map(([k, v]) => `  ${k}: ${v}`);
  for (const w of c.warnings) lines.push(`  ! ${w}`);
  return lines;
}
