import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ApiClient, DryRunRequest } from '../src/core/client';
import { CliError } from '../src/core/errors';

const TOKEN = `bqat_${'a'.repeat(16)}_${'A'.repeat(43)}`;

let server: ReturnType<typeof Bun.serve>;
let hits: { url: string; auth: string | null; method: string; body: string }[] =
  [];
let behavior: (req: Request) => Response = () =>
  Response.json({ success: true, ok: true });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      hits.push({
        url: new URL(req.url).pathname + new URL(req.url).search,
        auth: req.headers.get('authorization'),
        method: req.method,
        body,
      });
      return behavior(req);
    },
  });
});

afterAll(() => server.stop(true));

function client(
  opts: Partial<Parameters<typeof ApiClient.prototype.request>[2]> &
    Record<string, unknown> = {},
) {
  hits = [];
  return new ApiClient({
    apiUrl: `http://127.0.0.1:${server.port}`,
    token: TOKEN,
    ...(opts as any),
  });
}

describe('ApiClient', () => {
  test('sends the bearer token on /v1 paths', async () => {
    behavior = () => Response.json({ success: true, vms: [] });
    const c = client();
    const out = await c.get(['vms']);
    expect(out.vms).toEqual([]);
    expect(hits[0].url).toBe('/v1/vms');
    expect(hits[0].auth).toBe(`Bearer ${TOKEN}`);
  });

  test('encodes path segments safely', async () => {
    behavior = () => Response.json({ success: true });
    const c = client();
    await c.get(['vms', 'a b?d']);
    expect(hits[0].url).toBe('/v1/vms/a%20b%3Fd');
    await expect(c.get(['vms', '..'])).rejects.toMatchObject({ code: 'usage' });
    expect(hits).toHaveLength(1);
  });

  test('refuses redirects so the token is never forwarded', async () => {
    behavior = () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/' },
      });
    const c = client();
    await expect(c.get(['vms'])).rejects.toMatchObject({ code: 'server' });
  });

  test('retries GET on 429 honoring Retry-After, but never POST', async () => {
    let n = 0;
    behavior = () =>
      n++ === 0
        ? Response.json(
            { success: false, message: 'slow down' },
            { status: 429, headers: { 'Retry-After': '0' } },
          )
        : Response.json({ success: true, vms: [] });
    const c = client();
    const out = await c.get(['vms']);
    expect(out.vms).toEqual([]);
    expect(n).toBe(2);

    n = 0;
    behavior = () =>
      Response.json(
        { success: false, message: 'slow down' },
        { status: 429, headers: { 'Retry-After': '0' } },
      );
    await expect(c.post(['vms'], {})).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfter: 0,
    });
    expect(hits.filter((h) => h.method === 'POST')).toHaveLength(1);
  });

  test('retries a GET once on network error', async () => {
    let n = 0;
    const failThenOk = async () => {
      n++;
      if (n === 1) throw new Error('conn refused');
      return Response.json({ success: true });
    };
    const c = client({ fetchImpl: failThenOk as unknown as typeof fetch });
    await c.get(['vms']);
    expect(n).toBe(2);
  });

  test('maps statuses to error codes', async () => {
    const cases: [number, string][] = [
      [400, 'invalid_request'],
      [401, 'unauthenticated'],
      [402, 'payment_required'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [500, 'server'],
    ];
    for (const [status, code] of cases) {
      behavior = () =>
        Response.json({ success: false, message: `m${status}` }, { status });
      const c = client();
      await expect(c.get(['x'])).rejects.toMatchObject({ code, status });
    }
  });

  test('treats non-JSON responses as server errors without dumping HTML', async () => {
    behavior = () =>
      new Response('<html><body>huge error page</body></html>', {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      });
    const c = client();
    const err = await c.get(['x']).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('server');
    expect(err.message).not.toContain('<html>');
  });

  test('a slow 429 then 200 succeeds because each attempt gets a fresh timeout', async () => {
    const signals: AbortSignal[] = [];
    const slow: typeof fetch = (async (_u: any, init: any) => {
      signals.push(init.signal);
      if (signals.length === 1) {
        await new Promise((r) => setTimeout(r, 60));
        return Response.json(
          { success: false, message: 'slow down' },
          { status: 429, headers: { 'Retry-After': '0' } },
        );
      }
      expect(init.signal.aborted).toBe(false);
      return Response.json({ success: true, ok: true });
    }) as any;
    const c = client({ fetchImpl: slow, timeoutMs: 30 });
    const out = await c.get(['vms']);
    expect(out.ok).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  test('dry-run throws a descriptor and sends nothing', async () => {
    behavior = () => Response.json({ success: true });
    const c = client({ dryRun: true });
    const err = await c.post(['vms'], { a: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(DryRunRequest);
    expect(err.method).toBe('POST');
    expect(err.url).toContain('/v1/vms');
    expect(err.body).toEqual({ a: 1 });
    expect(hits).toHaveLength(0);
  });
});
