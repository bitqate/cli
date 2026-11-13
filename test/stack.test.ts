import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateSecrets,
  isDatabaseImage,
  missingInputs,
  parseInputFlags,
  parseStackConfig,
  renderEnv,
  resolveInputs,
  stackHostname,
} from '../src/core/stack-config';
import { runStack } from '../src/commands/stack';
import { readComposeLink } from '../src/commands/compose';
import { CliError } from '../src/core/errors';

const TOML = `
secrets = ["db_password"]

[[inputs]]
key = "admin_email"
label = "Admin email"
type = "email"

[services.web]
dockerfile = "web/Dockerfile"
port = 3000
resources = { ram = 1024, cpu = 100, disk = 10 }

[services.web.env]
DATABASE_URL = "postgres://app:{{secrets.db_password}}@{{services.db.host}}:{{services.db.port}}/app"
ADMIN = "{{inputs.admin_email}}"

[services.db]
image = "postgres:18"
env = { POSTGRES_PASSWORD = "{{secrets.db_password}}" }
`;

describe('parseStackConfig', () => {
  test('orders services after the ones they reference', () => {
    const c = parseStackConfig(TOML);
    expect(c.services.map((s) => s.name)).toEqual(['db', 'web']);
    expect(c.services[1].dockerfile).toBe('web/Dockerfile');
    expect(c.services[0].resources).toEqual({ ram: 512, cpu: 100, disk: 5 });
    expect(c.inputs[0]).toMatchObject({ type: 'email', required: true });
  });

  test.each([
    ['invalid toml', 'services = ['],
    ['no services', 'secrets = []'],
    ['neither image nor dockerfile', '[services.web]\nport = 80'],
    [
      'both image and dockerfile',
      '[services.web]\nimage = "nginx"\ndockerfile = "Dockerfile"',
    ],
    ['dockerfile outside the repo', '[services.web]\ndockerfile = "../x"'],
    ['vpn', '[services.web]\nimage = "alpine"\nvpn = true'],
    ['bad service name', '[services.Web]\nimage = "nginx"'],
    ['database with port', '[services.db]\nimage = "postgres:18"\nport = 5432'],
    [
      'unknown secret',
      '[services.web]\nimage = "nginx"\nenv = { A = "{{secrets.x}}" }',
    ],
    [
      'self reference',
      '[services.web]\nimage = "nginx"\nenv = { A = "{{services.web.host}}" }',
    ],
    [
      'cycle',
      '[services.a]\nimage = "nginx"\nenv = { X = "{{services.b.host}}" }\n[services.b]\nimage = "nginx"\nenv = { X = "{{services.a.host}}" }',
    ],
    [
      'public placeholders',
      '[services.web]\nimage = "nginx"\nports = [{ key = "rtc", internalPort = 5000 }]\nenv = { A = "{{public.rtc}}" }',
    ],
    [
      'resources out of range',
      '[services.web]\nimage = "nginx"\nresources = { ram = 1, cpu = 100, disk = 5 }',
    ],
  ])('rejects %s', (_label, text) => {
    expect(() => parseStackConfig(text)).toThrow(CliError);
  });
});

describe('inputs and rendering', () => {
  const config = parseStackConfig(TOML);

  test('parses --input flags', () => {
    expect(parseInputFlags(['a=1', 'b=x=y'])).toEqual({ a: '1', b: 'x=y' });
    expect(() => parseInputFlags(['nope'])).toThrow(CliError);
  });

  test('validates and requires inputs', () => {
    expect(missingInputs(config, {}).map((i) => i.key)).toEqual([
      'admin_email',
    ]);
    expect(() => resolveInputs(config, {})).toThrow(/--input admin_email/);
    expect(() => resolveInputs(config, { admin_email: 'nope' })).toThrow(
      /email/,
    );
    expect(() => resolveInputs(config, { other: 'x' })).toThrow(/Unknown/);
    expect(resolveInputs(config, { admin_email: 'a@b.co' })).toEqual({
      admin_email: 'a@b.co',
    });
  });

  test('renders placeholders', () => {
    const secrets = generateSecrets(config);
    expect(secrets.db_password).toMatch(/^[A-Za-z0-9]{32}$/);
    const env = renderEnv(config.services[1], {
      inputs: { admin_email: 'a@b.co' },
      secrets,
      services: { db: { host: 'shop-db.internal', port: 26001 } },
    });
    expect(env).toEqual({
      DATABASE_URL: `postgres://app:${secrets.db_password}@shop-db.internal:26001/app`,
      ADMIN: 'a@b.co',
    });
  });

  test('hostnames and database images match the dashboard', () => {
    expect(stackHostname('My Shop!', 'web')).toBe('my-shop-web');
    expect(stackHostname('x'.repeat(60), 'web')).toHaveLength(40);
    expect(isDatabaseImage('postgres:18')).toBe(true);
    expect(isDatabaseImage('docker.io/library/redis')).toBe(true);
    expect(isDatabaseImage('bitnami/postgresql')).toBe(false);
  });
});

function fakeCtx(calls: string[], opts: { failSecond?: boolean } = {}) {
  let serverN = 0;
  const api = {
    async get(p: string[]) {
      calls.push(`GET ${p.join('/')}`);
      if (p[0] === 'prices') return { prices: [] };
      if (p[0] === 'daemons')
        return { daemons: [{ id: 'd1', name: 'r1', location: 'x' }] };
      if (p[0] === 'servers')
        return { server: { address: { host: 'h', port: 26401 } } };
      return {};
    },
    async post(p: string[], b?: any) {
      calls.push(`POST ${p.join('/')} ${b ? JSON.stringify(b) : ''}`.trim());
      if (p[0] === 'projects')
        return {
          success: true,
          project: {
            id: 'p1',
            environments: [{ id: 'e1', kind: 'production' }],
          },
        };
      if (p[0] === 'servers' && p.length === 1) {
        serverN++;
        if (opts.failSecond && serverN === 2)
          return { success: false, message: 'no capacity' };
        return { success: true, id: `s${serverN}` };
      }
      return { success: true };
    },
    async put(p: string[], b: any) {
      calls.push(`PUT ${p.join('/')} ${JSON.stringify(b)}`);
      return { success: true };
    },
    async upload(p: string[]) {
      calls.push(`UPLOAD ${p.join('/')}`);
      return { success: true };
    },
  };
  return {
    api: () => api,
    args: [],
    flags: {
      region: 'd1',
      yes: true,
      name: 'shop',
      input: ['admin_email=a@b.co'],
    },
    io: {
      json: false,
      quiet: true,
      yes: true,
      interactive: false,
      verbose: false,
      theme: { paint: (_: string, t: string) => t, glyph: (g: string) => g },
    },
  } as any;
}

function stackDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-'));
  fs.writeFileSync(path.join(dir, 'bitqate.toml'), TOML);
  fs.mkdirSync(path.join(dir, 'web'));
  fs.writeFileSync(path.join(dir, 'web', 'Dockerfile'), 'FROM scratch\n');
  return dir;
}

describe('runStack', () => {
  test('creates everything on the network before starting in order', async () => {
    const dir = stackDir();
    const calls: string[] = [];
    const r = await runStack(fakeCtx(calls), dir);
    expect(r.data.project.id).toBe('p1');

    const creates = calls.filter((c) => c.startsWith('POST servers {'));
    expect(creates).toHaveLength(2);
    const db = JSON.parse(creates[0].slice('POST servers '.length));
    const web = JSON.parse(creates[1].slice('POST servers '.length));
    expect(db).toMatchObject({
      name: 'shop-db',
      mode: 'image',
      image: 'postgres:18',
      autoStart: false,
    });
    expect(web).toMatchObject({
      name: 'shop-web',
      mode: 'git',
      appPort: 3000,
      ram: 1024,
      autoStart: false,
    });
    expect(web.variables.DATABASE_URL).toMatch(
      /^postgres:\/\/app:[A-Za-z0-9]{32}@shop-db\.internal:26401\/app$/,
    );
    expect(web.variables.DATABASE_URL).toContain(
      db.variables.POSTGRES_PASSWORD,
    );
    expect(web.variables.ADMIN).toBe('a@b.co');

    const step = (prefix: string) =>
      calls.findIndex((c) => c.startsWith(prefix));
    expect(step('PUT servers/s1/private-network')).toBeGreaterThan(-1);
    expect(calls).toContain(
      'PUT servers/s2/private-network {"enabled":true,"hostname":"shop-web"}',
    );
    const lastSetup = Math.max(
      step('PUT servers/s2/private-network'),
      step(
        'PUT projects/p1/environments/e1/resources {"type":"server","id":"s2"}',
      ),
    );
    expect(step('POST servers/s1/start')).toBeGreaterThan(lastSetup);
    expect(step('UPLOAD servers/s2/deploy/upload')).toBeGreaterThan(
      step('POST servers/s1/start'),
    );

    const link = readComposeLink(dir);
    expect(link?.services).toEqual({
      db: { id: 's1', name: 'shop-db' },
      web: { id: 's2', name: 'shop-web' },
    });
  });

  test('a second run re-uploads only the built services', async () => {
    const dir = stackDir();
    await runStack(fakeCtx([]), dir);
    const calls: string[] = [];
    const r = await runStack(fakeCtx(calls), dir);
    expect(r.data.reUpload).toBe(true);
    expect(calls.filter((c) => c.startsWith('POST servers {'))).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith('UPLOAD'))).toEqual([
      'UPLOAD servers/s2/deploy/upload',
    ]);
  });

  test('a failed create starts nothing and writes no link', async () => {
    const dir = stackDir();
    const calls: string[] = [];
    await expect(
      runStack(fakeCtx(calls, { failSecond: true }), dir),
    ).rejects.toThrow(/Could not create web: no capacity/);
    expect(calls.some((c) => c.endsWith('/start'))).toBe(false);
    expect(calls.some((c) => c.startsWith('UPLOAD'))).toBe(false);
    expect(readComposeLink(dir)).toBeNull();
  });

  test('missing inputs fail before anything is created', async () => {
    const dir = stackDir();
    const calls: string[] = [];
    const ctx = fakeCtx(calls);
    ctx.flags.input = [];
    await expect(runStack(ctx, dir)).rejects.toThrow(/--input admin_email/);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  test('dry run plans without creating', async () => {
    const dir = stackDir();
    const calls: string[] = [];
    const ctx = fakeCtx(calls);
    ctx.flags['dry-run'] = true;
    const r = await runStack(ctx, dir);
    expect(r.data.plan.services.map((s: any) => [s.name, s.kind])).toEqual([
      ['db', 'database'],
      ['web', 'build'],
    ]);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });
});
