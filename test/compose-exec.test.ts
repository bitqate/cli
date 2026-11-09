import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { planCompose } from '../src/core/compose';
import {
  serviceBody,
  databaseImage,
  runCompose,
  writeComposeLink,
  readComposeLink,
} from '../src/commands/compose';
import { CliError } from '../src/core/errors';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-'));
fs.writeFileSync(
  path.join(dir, 'compose.yaml'),
  `
name: testproj
services:
  db: { image: postgres:16, environment: { POSTGRES_PASSWORD: x } }
  api:
    build: { context: ./app, dockerfile: Dockerfile.web }
    ports: ["8080:3000"]
    volumes: ["./data:/data", "./x:/x2"]
    environment: { DATABASE_URL: postgres://db:5432/app }
    depends_on: [db]
  cache: { image: redis:latest }
`,
);
fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
fs.writeFileSync(path.join(dir, 'app', 'Dockerfile.web'), 'FROM scratch\n');

const plan = planCompose(
  (await import('yaml')).parse(
    fs.readFileSync(path.join(dir, 'compose.yaml'), 'utf8'),
  ),
  { dir },
);
const svc = (n: string) => plan.services.find((s) => s.name === n)!;

describe('serviceBody', () => {
  test('database keeps explicit tag, cpu in units', () => {
    const { body } = serviceBody(svc('db'), { region: 'd1' });
    expect(body.image).toBe('postgres:16');
    expect(body.cpu).toBe(50);
    expect(body.mode).toBe('image');
    expect(body.database).toBeUndefined();
  });
  test('untagged/:latest uses managed image', () => {
    expect(databaseImage(svc('cache'))).toBe('redis:8');
  });
  test('build: git mode, appPort/dataPath, extraMounts, ports separate', () => {
    const { body, extraPorts } = serviceBody(svc('api'), { region: 'd1' });
    expect(body.mode).toBe('git');
    expect(body.appPort).toBe(3000);
    expect(body.dataPath).toBe('/data');
    expect(body.extraMounts).toEqual([{ containerPath: '/x2' }]);
    expect(Array.isArray(extraPorts)).toBe(true);
  });
});

// Minimal RunContext fake with an api() stub recording calls.
function fakeCtx(
  calls: string[],
  opts: { failNet?: boolean; failSecond?: boolean } = {},
) {
  let serverN = 0;
  const api = {
    async get(p: string[]) {
      calls.push(`GET ${p.join('/')}`);
      if (p[0] === 'prices') return { prices: [] };
      if (p[0] === 'daemons')
        return { daemons: [{ id: 'd1', name: 'r1', location: 'x' }] };
      if (p[0] === 'servers') {
        return { server: { address: { host: 'h', port: 26401 } } };
      }
      return {};
    },
    async post(p: string[], b: any) {
      calls.push(`POST ${p.join('/')} ${JSON.stringify(b)}`);
      if (p[0] === 'projects')
        return {
          success: true,
          project: {
            id: 'p1',
            environments: [{ id: 'e1', kind: 'production' }],
          },
        };
      if (p[0] === 'servers') {
        serverN++;
        if (opts.failSecond && serverN === 2) return { success: false };
        return { success: true, id: `s${serverN}` };
      }
      return { success: true };
    },
    async put(p: string[], b: any) {
      calls.push(`PUT ${p.join('/')} ${JSON.stringify(b)}`);
      if (opts.failNet && p[2] === 'private-network')
        throw new Error('net err');
      return { success: true };
    },
    async upload() {
      return { success: true };
    },
  };
  return {
    api: () => api,
    args: [],
    flags: { region: 'd1', yes: true },
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

describe('runCompose happy path', () => {
  test('order: project → dbs → poll → create → upload → ports → net → resources, link written', async () => {
    fs.rmSync(path.join(dir, '.bitqate.json'), { force: true });
    const calls: string[] = [];
    const ctx = fakeCtx(calls);
    const r = await runCompose(ctx, dir, 'compose.yaml');
    expect(r.data.project.id).toBe('p1');
    const order = calls.map((c) => c.split(' ')[0] + ' ' + c.split(' ')[1]);
    expect(order.indexOf('POST projects')).toBeLessThan(
      order.indexOf('POST servers'),
    );
    const creates = calls.filter((c) => c.startsWith('POST servers'));
    expect(creates.length).toBe(3);
    // app create carries rewritten DATABASE_URL (assigned port 26401)
    const appCreate = creates.find((c) => c.includes('"name":"api"'))!;
    expect(appCreate).toContain('db:26401');
    expect(appCreate).toContain('"appPort":3000');
    expect(calls.some((c) => c.includes('private-network'))).toBe(true);
    expect(calls.some((c) => c.includes('resources'))).toBe(true);
    const link = readComposeLink(dir);
    expect(link?.project.id).toBe('p1');
    expect(Object.keys(link!.services)).toEqual(['db', 'cache', 'api']);
  });
  test('private-network failure → warning + non-zero exit after summary', async () => {
    fs.rmSync(path.join(dir, '.bitqate.json'), { force: true });
    const ctx = fakeCtx([], { failNet: true });
    await expect(runCompose(ctx, dir, 'compose.yaml')).rejects.toThrow(
      /Some steps failed/,
    );
  });
  test('midway create failure prints created-so-far list', async () => {
    fs.rmSync(path.join(dir, '.bitqate.json'), { force: true });
    const ctx = fakeCtx([], { failSecond: true });
    await expect(runCompose(ctx, dir, 'compose.yaml')).rejects.toThrow(
      /Could not create/,
    );
  });
});
