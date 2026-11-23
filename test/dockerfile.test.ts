import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDockerfile } from '../src/core/dockerfile';
import { makeTheme } from '../src/ui/theme';

function context(
  stack: string,
  flags: Record<string, unknown> = {},
): { ctx: any; calls: () => number } {
  let calls = 0;
  const ctx = {
    flags,
    io: { theme: makeTheme(0, true), json: true, interactive: false },
    api: () => ({
      post: async () => {
        calls++;
        return { stack, label: 'Node.js', dockerfile: 'FROM node:24-alpine\n' };
      },
    }),
  };
  return { ctx, calls: () => calls };
}

function folder(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-df-gen-'));
  fs.writeFileSync(path.join(d, 'package.json'), '{}');
  return d;
}

describe('ensureDockerfile', () => {
  test('uses an existing Dockerfile as is', async () => {
    const d = folder();
    fs.writeFileSync(path.join(d, 'Dockerfile'), 'FROM x\n');
    const { ctx, calls } = context('node');
    expect(await ensureDockerfile(ctx, d, 'Dockerfile')).toBeNull();
    expect(calls()).toBe(0);
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('returns a generated Dockerfile without writing it, once per folder', async () => {
    const d = folder();
    const { ctx, calls } = context('node');
    expect(await ensureDockerfile(ctx, d, 'Dockerfile')).toBe(
      'FROM node:24-alpine\n',
    );
    expect(await ensureDockerfile(ctx, d, 'Dockerfile')).toBe(
      'FROM node:24-alpine\n',
    );
    expect(calls()).toBe(1);
    expect(fs.existsSync(path.join(d, 'Dockerfile'))).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('--write-dockerfile saves it to the folder', async () => {
    const d = folder();
    const { ctx } = context('node', { 'write-dockerfile': true });
    expect(await ensureDockerfile(ctx, d, 'Dockerfile')).toBeNull();
    expect(fs.readFileSync(path.join(d, 'Dockerfile'), 'utf8')).toBe(
      'FROM node:24-alpine\n',
    );
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('an unrecognized project still needs a Dockerfile', async () => {
    const d = folder();
    const { ctx } = context('generic');
    await expect(ensureDockerfile(ctx, d, 'Dockerfile')).rejects.toThrow(
      'could not be detected',
    );
    fs.rmSync(d, { recursive: true, force: true });
  });
});
