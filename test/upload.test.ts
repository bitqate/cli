import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API_URL, ApiClient, DryRunRequest } from '../src/core/client';
import { commands } from '../src/registry';
import { makeTheme } from '../src/ui/theme';
import { packSource } from '../src/core/source-archive';
import '../src/commands/servers';

const theme = makeTheme(0, true);
const TOKEN = `bqat_${'a'.repeat(16)}_${'A'.repeat(43)}`;

let hits: {
  url: string;
  method: string;
  body: Uint8Array;
  headers: Headers;
}[] = [];
let behavior: (req: Request) => Response | Promise<Response> = () =>
  Response.json({ success: true });

const fakeFetch = (async (input: any, init: any) => {
  const req = new Request(input, init);
  hits.push({
    url: req.url,
    method: req.method,
    body: new Uint8Array(await req.arrayBuffer()),
    headers: req.headers,
  });
  return behavior(req);
}) as unknown as typeof fetch;

function mkClient(opts: Record<string, unknown> = {}) {
  hits = [];
  return new ApiClient({
    token: TOKEN,
    fetchImpl: fakeFetch,
    ...(opts as any),
  });
}

describe('ApiClient.upload', () => {
  test('sends gzip content-type, auth and the query', async () => {
    behavior = () => Response.json({ success: true, deploymentId: 'd1' });
    const c = mkClient();
    const out = await c.upload(
      ['servers', 's1', 'deploy', 'upload'],
      new Uint8Array([0x1f, 0x8b, 9]),
      { query: { dockerfile: 'Dockerfile', commit: undefined }, summary: {} },
    );
    expect(out.deploymentId).toBe('d1');
    expect(hits.length).toBe(1);
    expect(hits[0].url).toBe(
      `${API_URL}/v1/servers/s1/deploy/upload?dockerfile=Dockerfile`,
    );
    expect(hits[0].headers.get('content-type')).toBe('application/gzip');
    expect(hits[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect([...hits[0].body]).toEqual([0x1f, 0x8b, 9]);
  });

  test('does not retry on a 5xx', async () => {
    behavior = () =>
      Response.json({ success: false, message: 'boom' }, { status: 500 });
    await expect(
      mkClient().upload(
        ['servers', 's1', 'deploy', 'upload'],
        new Uint8Array(2),
        {
          summary: {},
        },
      ),
    ).rejects.toThrow('boom');
    expect(hits.length).toBe(1);
  });

  test('a non-JSON 413 maps to a usage error', async () => {
    behavior = () => new Response('<html>cloudflare</html>', { status: 413 });
    await expect(
      mkClient().upload(
        ['servers', 's1', 'deploy', 'upload'],
        new Uint8Array(2),
        {
          summary: {},
        },
      ),
    ).rejects.toThrow('50 MB compressed');
  });

  test('dry run throws the summary without the bytes', async () => {
    const c = mkClient({ dryRun: true });
    try {
      await c.upload(
        ['servers', 's1', 'deploy', 'upload'],
        new Uint8Array([1, 2, 3, 4]),
        { summary: { archive: 'source.tar.gz', files: 4 } },
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DryRunRequest);
      expect((e as DryRunRequest).body).toEqual({
        archive: 'source.tar.gz',
        files: 4,
      });
    }
    expect(hits.length).toBe(0);
  });
});

function mkDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-upl-'));
  fs.writeFileSync(path.join(d, 'Dockerfile'), 'FROM x\n');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a');
  return d;
}

function mkCtx(flags: Record<string, any>, api: any, args: string[] = ['api']) {
  return {
    api: () => api,
    args,
    flags,
    io: {
      json: false,
      quiet: false,
      yes: true,
      interactive: false,
      theme,
      verbose: false,
    },
    config: {} as any,
    auth: {} as any,
  } as any;
}

const DAEMONS = { daemons: [{ id: 'd1', name: 'ca-mo-01' }] };

const deployCmd = commands.find((c) => c.path.join(' ') === 'servers deploy')!;
const createCmd = commands.find((c) => c.path.join(' ') === 'servers create')!;

describe('servers deploy --dir', () => {
  test('uploads gzip bytes to the upload endpoint with the query', async () => {
    const dir = mkDir();
    const calls: { segs: string[]; data: Uint8Array; opts: any }[] = [];
    const api = {
      upload: async (segs: string[], data: Uint8Array, opts: any) => {
        calls.push({ segs, data, opts });
        return { deploymentId: 'dep-1', status: 'building' };
      },
      post: async () => ({}),
      get: async (segs: string[]) =>
        segs[0] === 'servers' && segs.length === 1
          ? { servers: [{ id: 'srv-x', name: 'api' }] }
          : {},
    };
    const result = await deployCmd.run(mkCtx({ dir }, api, ['srv-x']));
    expect(calls.length).toBe(1);
    expect(calls[0].segs.join('/')).toContain('/deploy/upload');
    expect(calls[0].data[0]).toBe(0x1f);
    expect(calls[0].data[1]).toBe(0x8b);
    expect(calls[0].opts.query.dockerfile).toBe('Dockerfile');
    expect(result.data).toEqual({
      id: expect.any(String),
      deploymentId: 'dep-1',
      status: 'building',
      files: expect.any(Number),
      bytes: expect.any(Number),
      compressedBytes: expect.any(Number),
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('--dockerfile without --dir is a usage error', async () => {
    const api = { post: async () => ({}), get: async () => ({}) };
    await expect(
      deployCmd.run(mkCtx({ dockerfile: 'X' }, api as any)),
    ).rejects.toThrow('require --dir');
  });
});

describe('servers create --dir', () => {
  const flags = (extra: Record<string, any>) => ({
    name: 'app',
    region: 'ca-mo-01',
    'memory-mb': '512',
    cpus: '0.5',
    'disk-gb': '5',
    ...extra,
  });

  test('creates mode git then uploads to the new id', async () => {
    const dir = mkDir();
    const posts: any[] = [];
    const uploads: any[] = [];
    const api = {
      post: async (segs: string[], body: any) => {
        posts.push(body);
        return { id: 'new-id' };
      },
      upload: async (segs: string[], data: Uint8Array, opts: any) => {
        uploads.push({ segs, opts });
        return { deploymentId: 'd', status: 'building' };
      },
      get: async (segs: string[]) =>
        segs[0] === 'daemons'
          ? { daemons: [{ id: 'd1', name: 'ca-mo-01' }] }
          : {},
    };
    const result = await createCmd.run(mkCtx(flags({ dir }), api));
    expect(posts[0].mode).toBe('git');
    expect(uploads[0].segs.join('/')).toBe('servers/new-id/deploy/upload');
    expect(result.data.deploymentId).toBe('d');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('--dockerfile inside --dir still creates mode git', async () => {
    const dir = mkDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'Df'), 'FROM y\n');
    const posts: any[] = [];
    const api = {
      post: async (_s: string[], body: any) => {
        posts.push(body);
        return { id: 'x' };
      },
      upload: async (_s: string[], _d: Uint8Array, opts: any) => {
        expect(opts.query.dockerfile).toBe('sub/Df');
        return { deploymentId: 'd' };
      },
      get: async () => DAEMONS,
    };
    await createCmd.run(mkCtx(flags({ dir, dockerfile: 'sub/Df' }), api));
    expect(posts[0].mode).toBe('git');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing Dockerfile makes no create call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-nodf-'));
    let created = false;
    const api = {
      post: async () => {
        created = true;
        return { id: 'x' };
      },
      upload: async () => ({}),
      get: async () => DAEMONS,
    };
    await expect(createCmd.run(mkCtx(flags({ dir }), api))).rejects.toThrow(
      'No Dockerfile',
    );
    expect(created).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('upload failure after create reports the retry command', async () => {
    const dir = mkDir();
    const api = {
      post: async () => ({ id: 'x' }),
      upload: async () => {
        throw new Error('network down');
      },
      get: async () => DAEMONS,
    };
    await expect(createCmd.run(mkCtx(flags({ dir }), api))).rejects.toThrow(
      'Retry with: bitqate servers deploy',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('packSource names', () => {
  test('includes a .dockerignored Dockerfile', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-df2-'));
    fs.writeFileSync(path.join(d, 'Dockerfile'), 'FROM x\n');
    fs.writeFileSync(path.join(d, '.dockerignore'), 'Dockerfile\n');
    fs.writeFileSync(path.join(d, 'a.txt'), 'a');
    const packed = await packSource(d, ['a.txt'], { dockerfile: 'Dockerfile' });
    expect(packed.names).toContain('Dockerfile');
    fs.rmSync(d, { recursive: true, force: true });
  });
});
