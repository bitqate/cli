import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseDotenv } from '../src/core/dotenv';
import { detectPlatformConfig } from '../src/core/platform-config';
import { planCompose, interpolate, rewriteDbPorts } from '../src/core/compose';

describe('parseDotenv', () => {
  test('parses all supported forms', () => {
    const env = parseDotenv(`
# comment
A=1
export B=two
C='lit eral'
D="esc\\n\\t\\"\\\\x"
E= spaced # comment
F=
G="multi
line"
`);
    expect(env).toEqual({
      A: '1',
      B: 'two',
      C: 'lit eral',
      D: 'esc\n\t"\\x',
      E: 'spaced',
      F: '',
      G: 'multi\nline',
    });
  });
  test('rejects bad lines with line numbers', () => {
    expect(() => parseDotenv('A=1\nBAD LINE\n')).toThrow(/Line 2/);
    expect(() => parseDotenv('1X=y')).toThrow(/Line 1/);
    expect(() => parseDotenv('A="unclosed')).toThrow(/unterminated/);
  });
});

describe('detectPlatformConfig', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  test('fly.toml maps port, mounts, env, checks, dockerfile', () => {
    fs.writeFileSync(
      path.join(dir, 'fly.toml'),
      `
[env]
FOO = "bar"
[build]
dockerfile = "Dockerfile.prod"
[http_service]
internal_port = 3000
[[http_service.checks]]
path = "/healthz"
type = "http"
[mounts]
destination = "/data"
`,
    );
    const c = detectPlatformConfig(dir)!;
    expect(c.source).toBe('fly.toml');
    expect(c.appPort).toBe(3000);
    expect(c.dataPath).toBe('/data');
    expect(c.healthCheck?.path).toBe('/healthz');
    expect(c.dockerfilePath).toBe('Dockerfile.prod');
    expect(c.env.FOO).toBe('bar');
    fs.rmSync(path.join(dir, 'fly.toml'));
  });
  test('render.yaml maps fields and sync:false env', () => {
    fs.writeFileSync(
      path.join(dir, 'render.yaml'),
      `
services:
  - type: web
    name: app
    dockerfilePath: Dockerfile.api
    startCommand: node srv.js
    healthCheckPath: /up
    disk:
      mountPath: /storage
    envVars:
      - key: LIT
        value: yes
      - key: SECRET
        sync: false
`,
    );
    const c = detectPlatformConfig(dir)!;
    expect(c.dockerfilePath).toBe('Dockerfile.api');
    expect(c.startCommand).toBe('node srv.js');
    expect(c.healthCheck?.path).toBe('/up');
    expect(c.dataPath).toBe('/storage');
    expect(c.env.LIT).toBe('yes');
    expect(c.needsManualEnv).toEqual(['SECRET']);
    expect(c.appPort).toBeUndefined();
    fs.rmSync(path.join(dir, 'render.yaml'));
  });
  test('railway.json + Procfile precedence and warnings', () => {
    fs.writeFileSync(
      path.join(dir, 'railway.json'),
      JSON.stringify({
        build: { dockerfilePath: 'Dockerfile.r' },
        deploy: { startCommand: 'npm start', healthcheckPath: '/h' },
      }),
    );
    fs.writeFileSync(path.join(dir, 'Procfile'), 'web: node .');
    const c = detectPlatformConfig(dir)!;
    expect(c.source).toBe('railway.json');
    expect(c.dockerfilePath).toBe('Dockerfile.r');
    expect(c.healthCheck?.path).toBe('/h');
    expect(c.warnings.join()).toContain('Procfile');
  });
});

describe('compose', () => {
  test('interpolation', () => {
    const env = { A: 'x' };
    expect(interpolate('$A-${A}-$${A}-${MISSING:-d}-$$', env)).toBe(
      'x-x-${A}-d-$',
    );
    expect(interpolate('${MISSING-d}', env)).toBe('d');
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
  fs.writeFileSync(path.join(dir, '.env'), 'TAG=8\n');
  test('planCompose: kinds, ports, sizes, hostnames, mounts', () => {
    const plan = planCompose(
      {
        name: 'proj',
        services: {
          db: { image: 'postgres:16', environment: { POSTGRES_PASSWORD: 'x' } },
          cache: { image: 'redis:latest' },
          app: {
            build: { context: './app', dockerfile: 'Dockerfile.web' },
            ports: ['8080:3000', { target: 9090 }],
            expose: ['4000'],
            volumes: ['./data:/data', 'named:/other'],
            depends_on: ['db'],
            deploy: { resources: { limits: { memory: '700M', cpus: '0.7' } } },
            environment: ['DB=postgres://db:5432/x', 'P=$TAG'],
            healthcheck: { test: 'curl /' },
          },
          'weird name!': {
            image: 'nginx:1',
            ports: ['80:8080'],
            restart: 'always',
          },
        },
      },
      { dir },
    );
    const names = plan.services.map((s) => s.name);
    expect(names[0]).toBe('db');
    expect(names.indexOf('db')).toBeLessThan(names.indexOf('app'));
    const app = plan.services.find((s) => s.name === 'app')!;
    expect(app.kind).toBe('build');
    expect(app.appPort).toBe(3000);
    expect(app.dataPath).toBe('/data');
    expect(app.memoryMb).toBe(1024);
    expect(app.cpu).toBe(0.5);
    expect(app.env.P).toBe('8');
    expect(app.warnings.join()).toContain('healthcheck');
    expect(app.warnings.join()).toContain('not copied');
    const weird = plan.services.find((s) => s.name === 'weird name!')!;
    expect(weird.warnings.join()).toContain('adjusted');
    expect(weird.kind).toBe('image');
    expect(weird.internalPort).toBe(8080);
    expect(plan.services.find((s) => s.name === 'db')?.kind).toBe('database');
  });
  test('db port rewriting and bare-port warning', () => {
    const plan = planCompose(
      {
        services: {
          db: { image: 'postgres:16' },
          app: {
            build: '.',
            environment: { URL: 'postgres://db:5432/x', DB_PORT: '5432' },
          },
        },
      },
      { dir },
    );
    const warns = rewriteDbPorts(plan.services, new Map([['db', 26401]]));
    const app = plan.services.find((s) => s.name === 'app')!;
    expect(app.env.URL).toBe('postgres://db:26401/x');
    expect(warns.join()).toContain('DB_PORT');
  });
  test('depends_on cycle fails', () => {
    expect(() =>
      planCompose(
        {
          services: {
            a: { image: 'x', depends_on: ['b'] },
            b: { image: 'y', depends_on: ['a'] },
          },
        },
        { dir },
      ),
    ).toThrow(/cycle/);
  });
});

import { platformSummary } from '../src/core/platform-config';
import { envFromFilesAndFlags } from '../src/core/validate';

describe('platform wiring helpers', () => {
  test('envFromFilesAndFlags base merges under files and --env', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-'));
    const f = path.join(dir2, '.envfile');
    fs.writeFileSync(f, 'B=file\nC=file');
    const out = envFromFilesAndFlags([f], ['C=flag'], {
      A: 'cfg',
      B: 'cfg',
      C: 'cfg',
    });
    expect(out).toEqual({ A: 'cfg', B: 'file', C: 'flag' });
  });
  test('platformSummary covers each field and warnings', () => {
    const lines = platformSummary({
      source: 'fly.toml',
      appPort: 3000,
      dataPath: '/data',
      healthCheck: { type: 'http', path: '/h' },
      startCommand: 'node x',
      env: { A: '1' },
      needsManualEnv: ['SECRET'],
      warnings: ['w1'],
    }) as string[];
    const t = lines.join('\n');
    for (const frag of [
      'fly.toml',
      '3000',
      '/data',
      '/h',
      'node x',
      '1 var',
      'SECRET',
      'w1',
    ]) {
      expect(t).toContain(frag);
    }
    expect(
      platformSummary(
        { source: 'Procfile', env: {}, needsManualEnv: [], warnings: [] },
        true,
      ),
    ).toBe('');
  });
});

const tmpDir = os.tmpdir();
describe('compose fixes', () => {
  test('hostname rename flows through <name>:<port> and bare host env', () => {
    const plan = planCompose(
      {
        services: {
          my_db: { image: 'postgres:16' },
          app: {
            build: '.',
            environment: {
              URL: 'postgres://u@my_db:5432/x',
              DB_HOST: 'my_db',
              API: 'http://my_api:3000',
            },
          },
          my_api: { image: 'nginx' },
        },
      },
      { dir: tmpDir },
    );
    rewriteDbPorts(plan.services, new Map([['my_db', 26222]]));
    const app = plan.services.find((s) => s.name === 'app')!;
    expect(app.env.URL).toContain('my-db:26222');
    expect(app.env.DB_HOST).toBe('my-db');
    expect(app.env.API).toBe('http://my-api:3000');
  });
  test('mongo warns when MONGO_INITDB_ROOT_USERNAME is set', () => {
    const plan = planCompose(
      {
        services: {
          m: {
            image: 'mongo:8',
            environment: {
              MONGO_INITDB_ROOT_USERNAME: 'admin',
              MONGO_INITDB_ROOT_PASSWORD: 'x',
            },
          },
        },
      },
      { dir: tmpDir },
    );
    expect(plan.services[0].warnings.join()).toContain(
      'root user is always "root"',
    );
  });
});
