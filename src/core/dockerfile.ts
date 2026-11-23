import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError } from './errors';
import { sanitize } from './output';
import type { RunContext } from '../registry';
import { task } from '../ui/spinner';

export interface DockerfileSuggestion {
  stack: string;
  label: string;
  dockerfile: string;
}

export function rootFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .slice(0, 500);
  } catch {
    return [];
  }
}

export async function suggestDockerfile(
  ctx: RunContext,
  dir: string,
  startCommand?: string,
): Promise<DockerfileSuggestion | null> {
  const files = rootFiles(dir);
  let packageJson: unknown;
  if (files.includes('package.json')) {
    try {
      const raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
      if (raw.length < 512 * 1024) packageJson = JSON.parse(raw);
    } catch {}
  }
  try {
    const resp = await ctx.api().post(['dockerfile'], {
      files,
      package_json: packageJson,
      ...(startCommand ? { start_command: startCommand } : {}),
    });
    if (typeof resp?.dockerfile !== 'string') return null;
    return {
      stack: String(resp.stack ?? 'generic'),
      label: String(resp.label ?? 'project'),
      dockerfile: resp.dockerfile,
    };
  } catch {
    return null;
  }
}

const generated = new Map<string, string>();

export async function ensureDockerfile(
  ctx: RunContext,
  dir: string,
  relPath: string,
  startCommand?: string,
): Promise<string | null> {
  const abs = path.resolve(dir, relPath);
  if (existsSync(abs)) return null;
  const cached = generated.get(abs);
  if (cached !== undefined) return cached;
  const theme = ctx.io.theme;
  const folder = dir === '.' ? 'this folder' : dir;
  const where =
    relPath === 'Dockerfile' ? `in ${folder}` : `at ${path.join(dir, relPath)}`;
  const suggestion = await task('Looking at your project', theme, () =>
    suggestDockerfile(ctx, dir, startCommand),
  );
  if (!suggestion || suggestion.stack === 'generic') {
    throw new CliError(
      'usage',
      `No Dockerfile found ${where}, and the project type could not be detected.`,
      {
        hint: 'Add a Dockerfile that listens on 0.0.0.0 and the PORT environment variable, then run this again',
      },
    );
  }
  if (ctx.flags['write-dockerfile']) {
    writeFileSync(abs, suggestion.dockerfile, { flag: 'wx' });
    if (!ctx.io.json)
      process.stderr.write(
        `${theme.paint('success', theme.glyph('check'))} Wrote ${sanitize(path.relative(process.cwd(), abs) || 'Dockerfile')} ${theme.paint('muted', '(review and commit it)')}\n`,
      );
    return null;
  }
  if (!ctx.io.json)
    process.stderr.write(
      `${theme.paint('warning', theme.glyph('bang'))} No Dockerfile ${sanitize(where)}. This looks like a ${theme.paint('strong', suggestion.label)} project, so this deploy uses a generated Dockerfile. Your folder stays unchanged.\n${theme.paint('muted', 'Pass --write-dockerfile to save it to the folder instead.')}\n`,
    );
  generated.set(abs, suggestion.dockerfile);
  return suggestion.dockerfile;
}
