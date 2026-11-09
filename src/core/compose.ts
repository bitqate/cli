import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { parseDotenv } from './dotenv';
import { usageError } from './errors';

export type ServiceKind = 'database' | 'build' | 'image';

export interface PlannedService {
  name: string;
  hostname: string;
  kind: ServiceKind;
  engine?: 'postgres' | 'mysql' | 'mongo' | 'redis';
  image?: string;
  build?: { context: string; dockerfile?: string };
  env: Record<string, string>;
  appPort?: number;
  dataPath?: string;
  extraMounts: Array<{ source: string; target: string }>;
  extraPorts: number[];
  internalPort?: number;
  command?: string;
  memoryMb: number;
  cpu: number;
  diskGb: number;
  warnings: string[];
}

export interface ComposePlan {
  name: string;
  services: PlannedService[];
  warnings: string[];
}

const DB_IMAGES: Record<string, PlannedService['engine']> = {
  postgres: 'postgres',
  mysql: 'mysql',
  mongo: 'mongo',
  redis: 'redis',
};
const DB_PORTS: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  mongo: 27017,
  redis: 6379,
};

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export function sanitizeHostname(name: string, index = 0): string {
  const h = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return HOSTNAME_RE.test(h) ? h : `svc-${index || 1}`.slice(0, 40);
}

export function loadComposeEnv(
  dir: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  const envFile = path.join(dir, '.env');
  if (fs.existsSync(envFile)) {
    Object.assign(out, parseDotenv(fs.readFileSync(envFile, 'utf-8')));
  }
  return { ...out, ...processEnv } as Record<string, string>;
}

export function interpolate(
  value: string,
  env: Record<string, string>,
): string {
  return value.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(:-|-|)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, k, _op, dflt, bare) => {
      if (m === '$$') return '$';
      if (bare !== undefined) return env[bare] ?? '';
      const v = env[k];
      return v !== undefined && v !== '' ? v : dflt;
    },
  );
}

function envOf(
  svc: any,
  dir: string,
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const ef = svc.env_file;
  for (const f of Array.isArray(ef) ? ef : ef ? [ef] : []) {
    const p = path.join(dir, String(f));
    if (fs.existsSync(p))
      Object.assign(out, parseDotenv(fs.readFileSync(p, 'utf-8')));
  }
  const e = svc.environment;
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    for (const [k, v] of Object.entries(e))
      out[k] = interpolate(String(v ?? ''), env);
  } else if (Array.isArray(e)) {
    for (const item of e) {
      const s = String(item);
      const i = s.indexOf('=');
      if (i > 0) out[s.slice(0, i)] = interpolate(s.slice(i + 1), env);
      else if (env[s] !== undefined) out[s] = env[s];
    }
  }
  return out;
}

function containerPorts(svc: any): number[] {
  const out: number[] = [];
  for (const p of svc.ports ?? []) {
    if (typeof p === 'object' && p !== null) {
      const t = Number(p.target ?? p.published);
      if (t) out.push(t);
      continue;
    }
    const s = String(p);
    const m = /^(?:[\d.]+:)?(\d+)(?::(\d+))?(?:\/\w+)?$/.exec(s);
    if (m) out.push(Number(m[2] ?? m[1]));
  }
  for (const e of svc.expose ?? []) {
    const n = Number(String(e).split('/')[0]);
    if (n) out.push(n);
  }
  return out;
}

const KNOWN = new Set([
  'image',
  'build',
  'environment',
  'env_file',
  'ports',
  'expose',
  'volumes',
  'command',
  'depends_on',
  'deploy',
  'name',
  'container_name',
]);

function roundMemory(mb: number): number {
  return Math.min(16 * 1024, Math.max(512, Math.ceil(mb / 512) * 512));
}
function roundCpu(c: number): number {
  return Math.min(4, Math.max(0.5, Math.round(c * 2) / 2));
}

export function planCompose(
  doc: any,
  opts: {
    dir: string;
    env?: Record<string, string>;
    memoryMb?: number;
    cpus?: number;
    diskGb?: number;
  },
): ComposePlan {
  if (
    !doc ||
    typeof doc !== 'object' ||
    !doc.services ||
    typeof doc.services !== 'object'
  ) {
    throw usageError('No services found in the compose file');
  }
  const env = { ...loadComposeEnv(opts.dir), ...(opts.env ?? {}) };
  const warnings: string[] = [];
  const services: PlannedService[] = [];
  const usedHostnames = new Set<string>();

  for (const [rawName, svc] of Object.entries<any>(doc.services)) {
    const w: string[] = [];
    const name = String(rawName);
    let hostname = sanitizeHostname(name, services.length + 1);
    if (hostname !== name)
      w.push(`Hostname "${name}" adjusted to "${hostname}"`);
    while (usedHostnames.has(hostname)) hostname = `${hostname}x`.slice(0, 40);
    usedHostnames.add(hostname);
    for (const k of Object.keys(svc ?? {})) {
      if (!KNOWN.has(k))
        w.push(`Service "${name}": "${k}" is not supported and is ignored`);
    }

    const repo = String(svc.image ?? '')
      .split(':')[0]
      .toLowerCase();
    const engine = DB_IMAGES[repo];
    const serviceEnv = envOf(svc, opts.dir, env);
    const ports = containerPorts(svc);
    const lim = svc.deploy?.resources?.limits ?? {};
    const memoryMb =
      opts.memoryMb ?? (lim.memory ? roundMemory(parseMem(lim.memory)) : 512);
    const cpu = opts.cpus ?? (lim.cpus ? roundCpu(Number(lim.cpus)) : 0.5);
    const diskGb = opts.diskGb ?? 5;
    const mounts = ((svc.volumes ?? []) as any[]).map((v: any) =>
      typeof v === 'string'
        ? { source: v.split(':')[0] ?? '', target: v.split(':')[1] ?? '' }
        : { source: String(v.source ?? ''), target: String(v.target ?? '') },
    );

    if (engine) {
      if (engine === 'mongo' && 'MONGO_INITDB_ROOT_USERNAME' in serviceEnv) {
        w.push(
          'The MongoDB root user is always "root" on BitQate — MONGO_INITDB_ROOT_USERNAME is ignored; connect as "root" with the password',
        );
      }
      services.push({
        name,
        hostname,
        kind: 'database',
        engine,
        image: svc.image,
        env: serviceEnv,
        appPort: ports[0],
        extraMounts: mounts,
        extraPorts: ports.slice(1).filter((p) => p >= 1024),
        memoryMb,
        cpu,
        diskGb,
        warnings: w,
      });
    } else if (svc.build !== undefined) {
      const b =
        typeof svc.build === 'string'
          ? { context: svc.build }
          : (svc.build ?? {});
      const bindMounts = mounts.filter(
        (m) => m.source && !m.source.startsWith('/'),
      );
      if (bindMounts.length) {
        w.push(
          `Bind mounts (${bindMounts.map((m) => m.source).join(', ')}) are not copied — use the File Manager or Import from another host`,
        );
      }
      services.push({
        name,
        hostname,
        kind: 'build',
        build: {
          context: String(b.context ?? '.'),
          dockerfile: b.dockerfile ? String(b.dockerfile) : undefined,
        },
        env: serviceEnv,
        appPort: ports[0],
        dataPath: mounts[0]?.target || undefined,
        extraMounts: mounts.slice(1),
        extraPorts: ports.slice(1).filter((p) => p >= 1024),
        command: svc.command ? String(svc.command) : undefined,
        memoryMb,
        cpu,
        diskGb,
        warnings: w,
      });
    } else {
      const image = String(svc.image ?? '');
      if (/mariadb|bitnami\//i.test(repo)) {
        w.push(
          `"${repo}" isn't a managed database image — deployed as a plain server without the database tools`,
        );
      }
      if (ports[0] && svc.image) {
        w.push(
          `The image's first container port ${ports[0]} maps to the assigned port; other services still reach "${hostname}" at the private port`,
        );
      }
      services.push({
        name,
        hostname,
        kind: 'image',
        image,
        env: serviceEnv,
        internalPort: ports[0],
        extraPorts: ports.slice(1).filter((p) => p >= 1024),
        extraMounts: mounts,
        command: svc.command ? String(svc.command) : undefined,
        memoryMb,
        cpu,
        diskGb,
        warnings: w,
      });
    }
  }

  const byName = new Map(services.map((s) => [s.name, s]));
  const order: PlannedService[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const deps = new Map<string, string[]>();
  for (const [n, svc] of Object.entries<any>(doc.services)) {
    deps.set(
      n,
      (Array.isArray(svc.depends_on)
        ? svc.depends_on
        : svc.depends_on
          ? Object.keys(svc.depends_on)
          : []
      ).map(String),
    );
  }
  const visit = (n: string) => {
    if (seen.has(n)) return;
    if (visiting.has(n)) throw usageError(`depends_on cycle involving "${n}"`);
    if (!byName.has(n)) return;
    visiting.add(n);
    for (const d of deps.get(n) ?? []) visit(d);
    visiting.delete(n);
    seen.add(n);
    order.push(byName.get(n)!);
  };
  for (const s of services.filter((x) => x.kind === 'database')) visit(s.name);
  for (const s of services) visit(s.name);
  const dbs = order.filter((s) => s.kind === 'database');
  const rest = order.filter((s) => s.kind !== 'database');
  const ordered = [...dbs, ...rest];

  return {
    name: String(doc.name ?? path.basename(opts.dir)),
    services: ordered,
    warnings,
  };
}

export function rewriteDbPorts(
  services: PlannedService[],
  assigned: Map<string, number>,
): string[] {
  const warnings: string[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hostOf = new Map(services.map((s) => [s.name, s.hostname]));
  const rename = (host: string, port?: string | number) =>
    `${hostOf.get(host) ?? host}${port !== undefined ? ':' + port : ''}`;
  for (const s of services) {
    if (s.kind === 'database') continue;
    for (const [k, v] of Object.entries(s.env)) {
      let val = v;
      for (const [svcName, port] of assigned) {
        const dflt =
          DB_PORTS[services.find((x) => x.name === svcName)?.engine ?? ''] ?? 0;
        if (dflt) {
          const re = new RegExp(`\\b${esc(svcName)}:${dflt}\\b`, 'g');
          if (re.test(val)) {
            val = val.replace(re, rename(svcName, port));
            continue;
          }
        }
        if (val.trim() === svcName && svcName !== hostOf.get(svcName)) {
          val = rename(svcName);
          continue;
        }
        if (
          dflt &&
          val.trim() === String(dflt) &&
          /^(DB|DATABASE|MYSQL|PG|POSTGRES|MONGO|REDIS).*PORT/i.test(k)
        ) {
          warnings.push(
            `${s.name}.${k} is a bare default port (${dflt}) — set it to the assigned port ${port} yourself`,
          );
        }
      }
      for (const [other, host] of hostOf) {
        if (other === host) continue;
        val = val.replace(
          new RegExp(`\\b${esc(other)}:(\\d+)\\b`, 'g'),
          `${host}:$1`,
        );
      }
      s.env[k] = val;
    }
  }
  return warnings;
}

function parseMem(v: unknown): number {
  const s = String(v).trim().toLowerCase();
  const m = /^([\d.]+)\s*([kmgt]?i?b?|b)?$/.exec(s);
  const n = parseFloat(m?.[1] ?? '0');
  const unit = m?.[2] ?? '';
  if (unit.startsWith('g')) return n * 1024;
  if (unit.startsWith('k')) return n / 1024;
  return n;
}
