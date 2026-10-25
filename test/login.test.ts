import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = `bqat_${'a'.repeat(16)}_${'A'.repeat(43)}`;
const UUID = 'f1de2391-1c98-4497-afc1-ca20e310ad19';
const CLI = join(import.meta.dir, '..', 'src', 'index.ts');

let server: ReturnType<typeof Bun.serve>;
let trap = '';
let trapHits = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      trapHits++;
      return Response.json({ success: true });
    },
  });
  trap = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('BITQATE_')) continue;
    env[k] = v;
  }
  return env;
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
) {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    stdin: stdin !== undefined ? new Blob([stdin]) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...cleanEnv(), ...env },
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'bq-login-'));
}

describe('the API URL is never user-overridable', () => {
  test('auth login --api-url is rejected and stores nothing', async () => {
    trapHits = 0;
    const dir = freshDir();
    const r = await runCli(
      ['auth', 'login', '--api-url', trap, '--token-stdin'],
      { BITQATE_CONFIG_DIR: dir },
      TOKEN,
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown flag '--api-url'");
    expect(trapHits).toBe(0);
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
  });

  test('a leading --api-url is rejected before any request', async () => {
    trapHits = 0;
    const r = await runCli(['--api-url', trap, 'auth', 'status'], {
      BITQATE_CONFIG_DIR: freshDir(),
      BITQATE_TOKEN: TOKEN,
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown flag '--api-url'");
    expect(trapHits).toBe(0);
  });

  test('BITQATE_API_URL is ignored and never receives the token', async () => {
    trapHits = 0;
    const r = await runCli(
      ['vms', 'delete', UUID, '--yes', '--dry-run'],
      {
        BITQATE_CONFIG_DIR: freshDir(),
        BITQATE_API_URL: trap,
        BITQATE_TOKEN: TOKEN,
      },
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe(`DELETE https://api.bitqate.com/v1/vms/${UUID}\n`);
    expect(trapHits).toBe(0);
  });

  test('a profile api_url is ignored and never receives the token', async () => {
    trapHits = 0;
    const dir = freshDir();
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        current: 'default',
        profiles: { default: { api_url: trap, token: TOKEN } },
      }),
      { mode: 0o600 },
    );
    const r = await runCli(
      ['vms', 'delete', UUID, '--yes', '--dry-run'],
      { BITQATE_CONFIG_DIR: dir },
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe(`DELETE https://api.bitqate.com/v1/vms/${UUID}\n`);
    expect(trapHits).toBe(0);
  });
});
