import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type * as fs from 'node:fs';
import zlib from 'node:zlib';
import tar from 'tar-stream';
import ignore from '@balena/dockerignore';
import { usageError } from './errors';

export const MAX_SOURCE_COMPRESSED_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  '.vercel',
]);
const SKIP_FILES = new Set(['.DS_Store', '.env.local']);

function skipFile(name: string): boolean {
  return (
    SKIP_FILES.has(name) ||
    /^\.env\..*\.local$/.test(name) ||
    name.startsWith('npm-debug.log') ||
    name.endsWith('.swp')
  );
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

const toPosix = (p: string) => p.split(path.sep).join('/');

export function collectSourceFiles(dir: string): {
  files: string[];
  skipped: string[];
  mode: 'git' | 'walk';
} {
  const abs = path.resolve(dir);
  const files: string[] = [];
  const skipped: string[] = [];

  const inWorkTree = git(abs, ['rev-parse', '--is-inside-work-tree']);
  const dirIgnored =
    inWorkTree !== null && git(abs, ['check-ignore', '-q', '.']) !== null;

  if (inWorkTree !== null && !dirIgnored) {
    const out = git(abs, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
    if (out !== null) {
      for (const rel of out.split('\0')) {
        if (!rel) continue;
        const full = path.join(abs, rel);
        let st;
        try {
          st = lstatSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          skipped.push(toPosix(rel));
          continue;
        }
        files.push(toPosix(rel));
      }
      return finish(abs, files, skipped, 'git');
    }
  }

  const walk = (relDir: string) => {
    const absDir = path.join(abs, relDir);
    let ents;
    try {
      ents = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const full = path.join(absDir, ent.name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        files.push(rel);
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(rel);
        continue;
      }
      if (st.isFile()) {
        if (skipFile(ent.name)) continue;
        files.push(rel);
      }
    }
  };
  walk('');
  return finish(abs, files, skipped, 'walk');

  function finish(
    root: string,
    list: string[],
    skip: string[],
    mode: 'git' | 'walk',
  ) {
    const diPath = path.join(root, '.dockerignore');
    if (existsSync(diPath)) {
      const ig = ignore().add(readFileSync(diPath, 'utf8').split(/\r?\n/));
      list = list.filter((f) => !ig.ignores(f));
    }
    return { files: list.sort(), skipped: skip, mode };
  }
}

export interface PackOptions {
  dockerfile?: string;
  maxCompressedBytes?: number;
  maxEntries?: number;
  maxUncompressedBytes?: number;
}

export async function packSource(
  dir: string,
  files: string[],
  opts: PackOptions = {},
): Promise<{
  data: Uint8Array;
  files: number;
  bytes: number;
  names: string[];
}> {
  const abs = path.resolve(dir);
  const dockerfile = (opts.dockerfile ?? 'Dockerfile').replace(/\\/g, '/');
  const maxCompressed = opts.maxCompressedBytes ?? MAX_SOURCE_COMPRESSED_BYTES;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxUncompressed =
    opts.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;

  if (files.length > maxEntries) {
    throw usageError(
      `Too many files to upload (${files.length} > ${maxEntries}).`,
    );
  }

  const execBits = new Map<string, number>();
  if (process.platform === 'win32') {
    const out = git(abs, ['ls-files', '-s', '-z']);
    if (out) {
      for (const line of out.split('\0')) {
        const m = /^(\d+) [0-9a-f]+ \d+\t(.+)$/.exec(line);
        if (m) execBits.set(m[2], m[1] === '100755' ? 0o755 : 0o644);
      }
    }
  }

  const dfAbs = path.join(abs, dockerfile);
  if (!existsSync(dfAbs) || !statSync(dfAbs).isFile()) {
    throw usageError(
      `No Dockerfile at ${dockerfile} in ${dir}. Add one or pass --dockerfile <path>.`,
    );
  }

  const pack = tar.pack();
  const gz = zlib.createGzip();
  (pack as any).pipe(gz);
  const chunks: Buffer[] = [];
  let compressed = 0;
  const tooBig = () => compressed > maxCompressed;
  const collect = new Promise<void>((resolve, reject) => {
    gz.on('data', (c: Buffer) => {
      compressed += c.length;
      chunks.push(c);
    });
    gz.on('end', resolve);
    gz.on('error', reject);
    (pack as any).on('error', reject);
  });

  const entries = files.includes(dockerfile) ? files : [...files, dockerfile];

  let bytes = 0;
  const sized: { name: string; size: number }[] = [];
  const regular: { rel: string; st: fs.Stats }[] = [];
  const links: string[] = [];
  for (const rel of entries) {
    const full = path.join(abs, rel);
    let lst;
    try {
      lst = lstatSync(full);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink() && rel !== dockerfile) {
      links.push(rel);
      continue;
    }
    const st = statSync(full);
    if (!st.isFile()) continue;
    bytes += st.size;
    sized.push({ name: rel, size: st.size });
    regular.push({ rel, st });
  }
  if (regular.length + links.length > maxEntries) {
    throw usageError(
      `Too many files to upload (${regular.length + links.length} > ${maxEntries}).`,
    );
  }
  if (bytes > maxUncompressed) {
    throw usageError(
      `Source is too large uncompressed (${Math.ceil(bytes / (1024 * 1024))} MB > ${Math.floor(maxUncompressed / (1024 * 1024 * 1024))} GiB).`,
    );
  }

  const largest = () =>
    sized
      .slice()
      .sort((a, b) => b.size - a.size)
      .slice(0, 5)
      .map((f) => `${f.name} (${Math.ceil(f.size / 1024)} KB)`)
      .join(', ');
  const compressedError = () =>
    usageError(
      `Source archive exceeds ${Math.floor(maxCompressed / (1024 * 1024))} MB compressed. Largest files: ${largest()}`,
    );

  const names: string[] = [];
  for (const rel of links) {
    await new Promise<void>((res, rej) =>
      pack.entry(
        {
          name: rel,
          type: 'symlink',
          linkname: readlinkSync(path.join(abs, rel)),
          uid: 0,
          gid: 0,
        },
        (err) => (err ? rej(err) : res()),
      ),
    );
    names.push(rel);
  }
  for (const { rel, st } of regular) {
    const mode =
      process.platform === 'win32'
        ? (execBits.get(rel) ?? 0o644)
        : st.mode & 0o777;
    await new Promise<void>((res, rej) =>
      pack.entry(
        { name: rel, mode, uid: 0, gid: 0, mtime: st.mtime, size: st.size },
        readFileSync(path.join(abs, rel)),
        (err) => (err ? rej(err) : res()),
      ),
    );
    names.push(rel);
    if (tooBig()) throw compressedError();
  }
  pack.finalize();
  await collect;
  if (tooBig()) throw compressedError();
  return {
    data: Buffer.concat(chunks),
    files: names.length,
    bytes,
    names,
  };
}

export function gitInfo(dir: string): {
  commit?: string;
  branch?: string;
  subject?: string;
  dirty: boolean;
} {
  const commit = git(dir, ['rev-parse', 'HEAD'])?.trim() || undefined;
  if (!commit) return { dirty: false };
  const ref = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  const subject = git(dir, ['log', '-1', '--format=%s'])?.trim();
  const dirty = (git(dir, ['status', '--porcelain']) ?? '').length > 0;
  return {
    commit,
    branch: ref && ref !== 'HEAD' ? ref : undefined,
    subject: subject || undefined,
    dirty,
  };
}
