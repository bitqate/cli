import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import { collectSourceFiles, packSource } from '../src/core/source-archive';
import { resolveDeployDockerfile } from '../src/commands/servers';

function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-src-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: d });
  fs.writeFileSync(path.join(d, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(d, 'tracked.txt'), 't');
  fs.writeFileSync(path.join(d, 'Dockerfile'), 'FROM x\n');
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'i'],
    { cwd: d },
  );
  fs.writeFileSync(path.join(d, 'untracked.txt'), 'u');
  fs.writeFileSync(path.join(d, 'ignored.txt'), 'i');
  fs.writeFileSync(path.join(d, 'gone.txt'), 'g');
  execFileSync('git', ['add', 'gone.txt'], { cwd: d });
  fs.rmSync(path.join(d, 'gone.txt'));
  fs.mkdirSync(path.join(d, 'docs'));
  fs.writeFileSync(path.join(d, 'docs', 'a.md'), 'a');
  fs.writeFileSync(path.join(d, '.dockerignore'), 'docs/\n');
  fs.symlinkSync('untracked.txt', path.join(d, 'link'));
  return d;
}

async function entries(buf: Uint8Array) {
  const out: Record<string, { type: string; mode?: number }> = {};
  const ex = tar.extract();
  await new Promise<void>((res, rej) => {
    ex.on('entry', (h, body, next) => {
      out[h.name] = { type: h.type, mode: h.mode };
      body.resume();
      body.on('end', next);
    });
    ex.on('finish', () => res());
    ex.on('error', rej);
    Readable.from([zlib.gunzipSync(buf as Buffer)]).pipe(ex);
  });
  return out;
}

describe('collectSourceFiles + packSource', () => {
  test('git rules: tracked+untracked in, ignored/deleted/.git/.dockerignore out', async () => {
    const d = repo();
    const { files, mode } = collectSourceFiles(d);
    expect(mode).toBe('git');
    expect(files).toContain('untracked.txt');
    expect(files).toContain('tracked.txt');
    expect(files).not.toContain('ignored.txt');
    expect(files).not.toContain('gone.txt');
    expect(files).not.toContain('docs/a.md');
    expect(files.some((f) => f.startsWith('.git/'))).toBe(false);
    const ent = await entries(
      (await packSource(d, files, { dockerfile: 'Dockerfile' })).data,
    );
    expect(ent.link?.type).toBe('symlink');
    expect(ent.Dockerfile?.type).toBe('file');
    fs.rmSync(d, { recursive: true, force: true });
  });
  test('walk mode excludes + missing Dockerfile + limits', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-walk-'));
    fs.mkdirSync(path.join(d, 'node_modules'));
    fs.writeFileSync(path.join(d, 'node_modules/x.js'), 'x');
    fs.writeFileSync(path.join(d, 'a.txt'), 'a');
    const { files, mode } = collectSourceFiles(d);
    expect(mode).toBe('walk');
    expect(files).toEqual(['a.txt']);
    await expect(
      packSource(d, files, { dockerfile: 'Dockerfile' }),
    ).rejects.toThrow('No Dockerfile');
    fs.writeFileSync(path.join(d, 'Dockerfile'), 'FROM x\n');
    fs.writeFileSync(path.join(d, 'big'), 'x'.repeat(2048));
    await expect(
      packSource(d, ['a.txt', 'big'], {
        dockerfile: 'Dockerfile',
        maxUncompressedBytes: 100,
      }),
    ).rejects.toThrow('too large');
    await expect(
      packSource(d, ['a.txt'], { dockerfile: 'Dockerfile', maxEntries: 1 }),
    ).rejects.toThrow('Too many');
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('resolveDeployDockerfile', () => {
  const ctx = (flags: any) => ({ flags }) as any;
  test('defaults to <dir>/Dockerfile, never cwd', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-df-'));
    expect(resolveDeployDockerfile(ctx({}), d)).toBe('Dockerfile');
    expect(resolveDeployDockerfile(ctx({ dockerfile: 'sub/Df' }), d)).toBe(
      'sub/Df',
    );
    expect(() =>
      resolveDeployDockerfile(ctx({ dockerfile: '../x' }), d),
    ).toThrow('inside');
    expect(() => resolveDeployDockerfile(ctx({ dockerfile: d }), d)).toThrow(
      'a file inside',
    );
    fs.rmSync(d, { recursive: true, force: true });
  });
});
