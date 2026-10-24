import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = `bqat_${'a'.repeat(16)}_${'A'.repeat(43)}`;
const CLI = join(import.meta.dir, '..', 'src', 'index.ts');

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === '/v1/token') {
        return Response.json({
          success: true,
          token: {
            key_id: 'a'.repeat(16),
            name: 't',
            scopes: ['account:read'],
            created_at: 1,
            last_used_at: null,
            expires_at: null,
          },
        });
      }
      return Response.json(
        { success: false, message: 'not found' },
        { status: 404 },
      );
    },
  });
});

afterAll(() => server.stop(true));

async function runCli(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
) {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    stdin: stdin !== undefined ? new Blob([stdin]) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}

describe('auth login', () => {
  test('re-points a profile at a new API URL instead of tripping the binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bq-login-'));
    const env = { BITQATE_CONFIG_DIR: dir };
    const base = `http://127.0.0.1:${server.port}`;

    const first = await runCli(
      ['auth', 'login', '--api-url', base, '--token-stdin'],
      env,
      TOKEN,
    );
    expect(first.code).toBe(0);

    const second = await runCli(
      [
        'auth',
        'login',
        '--api-url',
        `http://localhost:${server.port}`,
        '--token-stdin',
      ],
      env,
      TOKEN,
    );
    expect(second.code).toBe(0);

    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(cfg.profiles.default.api_url).toBe(
      `http://localhost:${server.port}`,
    );
  });
});
