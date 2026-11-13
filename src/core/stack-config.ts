import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { parse as parseToml } from 'smol-toml';
import { usageError } from './errors';

export const STACK_CONFIG_FILE = 'bitqate.toml';

export type StackInputType = 'text' | 'password' | 'email' | 'url';

export interface StackInput {
  key: string;
  label: string;
  description?: string;
  type: StackInputType;
  default?: string;
  required: boolean;
}

export interface StackService {
  name: string;
  image?: string;
  dockerfile?: string;
  port?: number;
  dataPath?: string;
  env: Record<string, string>;
  ports: Array<{ key: string; internalPort: number; protocol: 'tcp' | 'udp' }>;
  resources: { ram: number; cpu: number; disk: number };
}

export interface StackConfig {
  inputs: StackInput[];
  secrets: string[];
  services: StackService[];
}

export interface RenderContext {
  inputs: Record<string, string>;
  secrets: Record<string, string>;
  services: Record<string, { host: string; port: number }>;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SERVICE_RE = /^[a-z][a-z0-9]{0,15}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLACEHOLDER_RE =
  /\{\{\s*(inputs|secrets|services|public)\.([a-z][a-z0-9_]*)(?:\.(host|port))?\s*\}\}/g;
const INPUT_TYPES: StackInputType[] = ['text', 'password', 'email', 'url'];
const DATABASE_REPOS = new Set(['postgres', 'mysql', 'mongo', 'redis']);
const DEFAULT_RESOURCES = { ram: 512, cpu: 100, disk: 5 };
const SECRET_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function findStackConfig(dir: string): string | null {
  return fs.existsSync(path.join(dir, STACK_CONFIG_FILE))
    ? STACK_CONFIG_FILE
    : null;
}

export function isDatabaseImage(image: string): boolean {
  let ref = image.trim().split('@')[0];
  ref = ref.replace(
    /^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//i,
    '',
  );
  ref = ref.replace(/^library\//, '');
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  const repo = colon > slash ? ref.slice(0, colon) : ref;
  return DATABASE_REPOS.has(repo.toLowerCase());
}

function fail(message: string): never {
  throw usageError(`${STACK_CONFIG_FILE}: ${message}`);
}

function isTable(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, where: string, max: number): string {
  if (typeof v !== 'string') fail(`${where} must be a string`);
  const s = v.trim();
  if (!s || s.length > max) fail(`${where} must be 1-${max} characters`);
  return s;
}

function int(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== 'number' && typeof v !== 'bigint') {
    fail(`${where} must be a whole number`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`${where} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function placeholders(value: string) {
  const found: Array<{ kind: string; name: string; field?: string }> = [];
  const rest = value.replace(PLACEHOLDER_RE, (_m, kind, name, field) => {
    found.push({ kind, name, field });
    return '';
  });
  if (rest.includes('{{')) {
    fail(`unknown placeholder in "${value.slice(0, 80)}"`);
  }
  return found;
}

function safeDockerfilePath(p: string): boolean {
  return (
    !p.startsWith('/') &&
    !/^[A-Za-z]:[\\/]/.test(p) &&
    !p.includes('\0') &&
    !p.split(/[\\/]/).some((segment) => segment === '..')
  );
}

function parseInput(raw: unknown, i: number): StackInput {
  const where = `inputs[${i}]`;
  if (!isTable(raw)) fail(`${where} must be a table`);
  const key = str(raw.key, `${where}.key`, 32);
  if (!KEY_RE.test(key)) {
    fail(`${where}.key must be lowercase letters, digits or _`);
  }
  const type = (raw.type ?? 'text') as StackInputType;
  if (!INPUT_TYPES.includes(type)) {
    fail(`${where}.type must be one of ${INPUT_TYPES.join(', ')}`);
  }
  if (raw.required !== undefined && typeof raw.required !== 'boolean') {
    fail(`${where}.required must be true or false`);
  }
  return {
    key,
    label: str(raw.label, `${where}.label`, 64),
    description:
      raw.description === undefined
        ? undefined
        : str(raw.description, `${where}.description`, 200),
    type,
    default:
      raw.default === undefined || raw.default === ''
        ? undefined
        : str(raw.default, `${where}.default`, 512),
    required: raw.required !== false,
  };
}

function parseService(name: string, raw: unknown): StackService {
  if (!SERVICE_RE.test(name)) {
    fail(
      `service "${name}" needs a name of 1-16 lowercase letters and digits, starting with a letter`,
    );
  }
  if (!isTable(raw)) fail(`services.${name} must be a table`);
  const image =
    raw.image === undefined ? undefined : str(raw.image, `${name}.image`, 255);
  const dockerfile =
    raw.dockerfile === undefined
      ? undefined
      : str(raw.dockerfile, `${name}.dockerfile`, 255);
  if (!image === !dockerfile) fail(`${name}: set either image or dockerfile`);
  if (dockerfile && !safeDockerfilePath(dockerfile)) {
    fail(`${name}: dockerfile must be a path inside the repository`);
  }
  if (raw.vpn) fail(`${name}: vpn is only available to BitQate's own apps`);
  const port =
    raw.port === undefined
      ? undefined
      : int(raw.port, `${name}.port`, 1, 65535);
  const dataPath =
    raw.dataPath === undefined
      ? undefined
      : str(raw.dataPath, `${name}.dataPath`, 255);
  if (dataPath !== undefined && !dataPath.startsWith('/')) {
    fail(`${name}: dataPath must be an absolute path`);
  }
  if (image && isDatabaseImage(image) && (port || dataPath)) {
    fail(`${name}: database images pick their own port and data directory`);
  }

  const env: Record<string, string> = {};
  if (raw.env !== undefined) {
    if (!isTable(raw.env)) fail(`${name}.env must be a table`);
    for (const [k, v] of Object.entries(raw.env)) {
      if (!ENV_KEY_RE.test(k)) fail(`${name}: invalid env name "${k}"`);
      if (typeof v !== 'string' || v.length > 2048) {
        fail(`${name}.env.${k} must be a string of at most 2048 characters`);
      }
      env[k] = v;
    }
  }

  const ports: StackService['ports'] = [];
  if (raw.ports !== undefined) {
    if (!Array.isArray(raw.ports) || raw.ports.length > 2) {
      fail(`${name}.ports must be a list of at most 2 ports`);
    }
    for (const [i, p] of raw.ports.entries()) {
      if (!isTable(p)) fail(`${name}.ports[${i}] must be a table`);
      const key = str(p.key, `${name}.ports[${i}].key`, 32);
      if (!KEY_RE.test(key) || key === 'address') {
        fail(`${name}.ports[${i}].key is not a valid port key`);
      }
      const protocol = (p.protocol ?? 'tcp') as 'tcp' | 'udp';
      if (protocol !== 'tcp' && protocol !== 'udp') {
        fail(`${name}.ports[${i}].protocol must be tcp or udp`);
      }
      ports.push({
        key,
        internalPort: int(
          p.internalPort,
          `${name}.ports[${i}].internalPort`,
          1024,
          65535,
        ),
        protocol,
      });
    }
  }

  let resources = DEFAULT_RESOURCES;
  if (raw.resources !== undefined) {
    if (!isTable(raw.resources)) fail(`${name}.resources must be a table`);
    resources = {
      ram: int(raw.resources.ram, `${name}.resources.ram`, 128, 65536),
      cpu: int(raw.resources.cpu, `${name}.resources.cpu`, 10, 1600),
      disk: int(raw.resources.disk, `${name}.resources.disk`, 1, 500),
    };
  }

  return { name, image, dockerfile, port, dataPath, env, ports, resources };
}

function unique(values: string[], what: string): Set<string> {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) fail(`duplicate ${what} "${v}"`);
    seen.add(v);
  }
  return seen;
}

function dependencies(service: StackService): Set<string> {
  const deps = new Set<string>();
  for (const value of Object.values(service.env)) {
    for (const p of placeholders(value)) {
      if (p.kind === 'services') deps.add(p.name);
    }
  }
  return deps;
}

export function orderServices(services: StackService[]): StackService[] {
  const remaining = [...services];
  const placed = new Set<string>();
  const ordered: StackService[] = [];
  while (remaining.length) {
    const i = remaining.findIndex((s) =>
      [...dependencies(s)].every((d) => placed.has(d)),
    );
    if (i === -1) fail('services reference each other in a cycle');
    const [next] = remaining.splice(i, 1);
    placed.add(next.name);
    ordered.push(next);
  }
  return ordered;
}

export function parseStackConfig(text: string): StackConfig {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    fail(`not valid TOML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isTable(raw)) fail('is empty');
  if (!isTable(raw.services) || !Object.keys(raw.services).length) {
    fail('needs at least one [services.<name>] table');
  }
  const services = Object.entries(raw.services).map(([n, v]) =>
    parseService(n, v),
  );
  if (services.length > 5) fail('a stack can have at most 5 services');

  if (raw.inputs !== undefined && !Array.isArray(raw.inputs)) {
    fail('inputs must be a list of [[inputs]] tables');
  }
  const inputs = ((raw.inputs as unknown[]) ?? []).map(parseInput);
  if (inputs.length > 10) fail('a stack can have at most 10 inputs');

  if (raw.secrets !== undefined && !Array.isArray(raw.secrets)) {
    fail('secrets must be a list of names');
  }
  const secrets = ((raw.secrets as unknown[]) ?? []).map((s, i) => {
    if (typeof s !== 'string' || !KEY_RE.test(s)) {
      fail(`secrets[${i}] must be lowercase letters, digits or _`);
    }
    return s;
  });
  if (secrets.length > 10) fail('a stack can have at most 10 secrets');

  const inputKeys = unique(
    inputs.map((i) => i.key),
    'input',
  );
  const secretKeys = unique(secrets, 'secret');
  const names = unique(
    services.map((s) => s.name),
    'service',
  );

  for (const s of services) {
    const portKeys = unique(
      s.ports.map((p) => p.key),
      `${s.name} port`,
    );
    unique(
      s.ports.map((p) => `${p.internalPort}/${p.protocol}`),
      `${s.name} internal port`,
    );
    if (
      s.ports.some((p) => p.protocol === 'tcp' && p.internalPort === s.port)
    ) {
      fail(`${s.name}: a port repeats the app port`);
    }
    for (const value of Object.values(s.env)) {
      for (const p of placeholders(value)) {
        if (p.kind === 'inputs' && (p.field || !inputKeys.has(p.name))) {
          fail(`${s.name}: unknown input "${p.name}"`);
        }
        if (p.kind === 'secrets' && (p.field || !secretKeys.has(p.name))) {
          fail(`${s.name}: unknown secret "${p.name}"`);
        }
        if (p.kind === 'public') {
          if (p.field || (p.name !== 'address' && !portKeys.has(p.name))) {
            fail(`${s.name}: unknown port "${p.name}"`);
          }
          fail(
            `${s.name}: {{public.${p.name}}} isn't supported by the CLI yet, deploy this stack from the dashboard`,
          );
        }
        if (p.kind === 'services') {
          if (!names.has(p.name) || p.name === s.name) {
            fail(`${s.name}: unknown service "${p.name}"`);
          }
          if (!p.field) {
            fail(
              `${s.name}: use services.${p.name}.host or services.${p.name}.port`,
            );
          }
        }
      }
    }
  }

  return { inputs, secrets, services: orderServices(services) };
}

export function readStackConfig(dir: string): StackConfig {
  const file = path.join(dir, STACK_CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    throw usageError(`Could not read ${file}`);
  }
  return parseStackConfig(text);
}

export function parseInputFlags(
  values: string[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values ?? []) {
    const i = v.indexOf('=');
    if (i <= 0) throw usageError(`--input expects key=value, got "${v}"`);
    out[v.slice(0, i).trim()] = v.slice(i + 1);
  }
  return out;
}

export function missingInputs(
  config: StackConfig,
  provided: Record<string, string>,
): StackInput[] {
  return config.inputs.filter(
    (i) => i.required && !i.default && !(provided[i.key] ?? '').trim(),
  );
}

export function checkInputKeys(
  config: StackConfig,
  provided: Record<string, string>,
): void {
  const known = new Set(config.inputs.map((i) => i.key));
  for (const key of Object.keys(provided)) {
    if (!known.has(key)) throw usageError(`Unknown input "${key}"`);
  }
}

export function resolveInputs(
  config: StackConfig,
  provided: Record<string, string>,
): Record<string, string> {
  checkInputKeys(config, provided);
  const out: Record<string, string> = {};
  for (const input of config.inputs) {
    const value = (provided[input.key] ?? '').trim() || input.default || '';
    if (!value && input.required) {
      throw usageError(
        `${input.label} is required: pass --input ${input.key}=...`,
      );
    }
    if (value.length > 512 || /[\0\r\n]/.test(value)) {
      throw usageError(`${input.label} is not valid`);
    }
    if (value && input.type === 'email' && !EMAIL_RE.test(value)) {
      throw usageError(`${input.label} must be an email address`);
    }
    if (value && input.type === 'url') {
      let ok = false;
      try {
        ok = ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {}
      if (!ok) throw usageError(`${input.label} must be a URL`);
    }
    out[input.key] = value;
  }
  return out;
}

export function randomSecret(length = 32): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248) out += SECRET_ALPHABET[b % SECRET_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateSecrets(config: StackConfig): Record<string, string> {
  return Object.fromEntries(config.secrets.map((k) => [k, randomSecret()]));
}

export function renderEnv(
  service: StackService,
  ctx: RenderContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(service.env)) {
    out[key] = value.replace(PLACEHOLDER_RE, (_m, kind, name, field) => {
      const v =
        kind === 'services'
          ? ctx.services[name]?.[field as 'host' | 'port']
          : kind === 'inputs' || kind === 'secrets'
            ? ctx[kind as 'inputs' | 'secrets'][name]
            : undefined;
      if (v === undefined) {
        throw usageError(`${service.name}: ${kind}.${name} is not set`);
      }
      return String(v);
    });
  }
  return out;
}

export function stackHostname(stack: string, service: string): string {
  const base = stack
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39 - service.length)
    .replace(/-+$/, '');
  return `${base || 'app'}-${service}`;
}
