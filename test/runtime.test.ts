import { describe, expect, test } from 'bun:test';
import { ApiClient } from '../src/core/client';
import { CliError } from '../src/core/errors';
import {
  ndjson,
  parseSince,
  pickRollbackTarget,
} from '../src/commands/runtime';

const TOKEN = `bqat_${'a'.repeat(16)}_${'A'.repeat(43)}`;

let behavior: (req: Request) => Response = () => new Response('');

const fakeFetch = (async (input: any, init: any) =>
  behavior(new Request(input, init))) as unknown as typeof fetch;

function client() {
  // apiUrl only exists on some versions of ClientOptions.
  return new ApiClient({
    token: TOKEN,
    fetchImpl: fakeFetch,
    ...({ apiUrl: 'https://api.bitqate.com' } as any),
  });
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

describe('parseSince', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  test('accepts durations', () => {
    expect(parseSince('90s', now)).toBe(now / 1000 - 90);
    expect(parseSince('2h', now)).toBe(now / 1000 - 7200);
    expect(parseSince('1d', now)).toBe(now / 1000 - 86400);
  });
  test('accepts dates', () => {
    expect(parseSince('2026-10-25T11:00:00Z', now)).toBe(now / 1000 - 3600);
  });
  test('rejects anything else as a usage error', () => {
    expect(() => parseSince('yesterday-ish', now)).toThrow(CliError);
  });
});

describe('ndjson', () => {
  test('yields objects across chunk boundaries and skips junk', async () => {
    const out: unknown[] = [];
    for await (const obj of ndjson(
      bodyOf('{"line":"a"}\n\nnot json\n{"line":"b"}\n{"line":"c"}'),
    ))
      out.push(obj);
    expect(out).toEqual([{ line: 'a' }, { line: 'b' }, { line: 'c' }]);
  });
});

describe('pickRollbackTarget', () => {
  const sha = (c: string) => c.repeat(40);
  test('picks the successful deploy before the live one', () => {
    const target = pickRollbackTarget([
      {
        id: '4',
        status: 'failed',
        commit_sha: sha('d'),
        created_at: '2026-10-25T04:00:00Z',
      },
      {
        id: '3',
        status: 'success',
        commit_sha: sha('c'),
        created_at: '2026-10-25T03:00:00Z',
      },
      {
        id: '2',
        status: 'success',
        commit_sha: 'HEAD',
        created_at: '2026-10-25T02:00:00Z',
      },
      {
        id: '1',
        status: 'success',
        commit_sha: sha('a'),
        created_at: '2026-10-25T01:00:00Z',
      },
    ]);
    expect(target?.id).toBe('1');
  });
  test('returns null with nothing to go back to', () => {
    expect(
      pickRollbackTarget([
        {
          id: '1',
          status: 'success',
          commit_sha: sha('a'),
          created_at: '2026-10-25T01:00:00Z',
        },
      ]),
    ).toBeNull();
  });
});

describe('ApiClient.stream', () => {
  test('sends the token and query and returns the open body', async () => {
    let seen = '';
    let auth: string | null = null;
    behavior = (req) => {
      seen = new URL(req.url).pathname + new URL(req.url).search;
      auth = req.headers.get('authorization');
      return new Response('{"t":null,"line":"hi"}\n', {
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    };
    const resp = await client().stream(['servers', 'abc', 'logs'], {
      tail: 10,
      since: undefined,
    });
    expect(seen).toBe('/v1/servers/abc/logs?tail=10');
    expect(auth).toBe(`Bearer ${TOKEN}`);
    expect(await resp.text()).toBe('{"t":null,"line":"hi"}\n');
  });

  test('maps error statuses like request()', async () => {
    behavior = () =>
      Response.json(
        { success: false, message: 'The server has no container yet' },
        { status: 404 },
      );
    const err = await client()
      .stream(['servers', 'abc', 'logs'])
      .catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(5);
    expect(err.message).toBe('The server has no container yet');
  });
});
