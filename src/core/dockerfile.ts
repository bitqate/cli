import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError } from './errors';
import { sanitize } from './output';
import type { RunContext } from '../registry';
import { confirm } from '../ui/prompts';
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
    const resp = await ctx
      .api()
      .post(['dockerfile'], { files, package_json: packageJson });
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

export async function ensureDockerfile(
  ctx: RunContext,
  dir: string,
  relPath: string,
): Promise<void> {
  const abs = path.resolve(dir, relPath);
  if (existsSync(abs)) return;
  const theme = ctx.io.theme;
  const folder = dir === '.' ? 'this folder' : dir;
  const where =
    relPath === 'Dockerfile' ? `in ${folder}` : `at ${path.join(dir, relPath)}`;
  if (!ctx.io.interactive || ctx.io.json) {
    throw new CliError('usage', `No Dockerfile found ${where}.`, {
      hint: 'Add a Dockerfile, pass --dockerfile <path>, or run bitqate deploy on a terminal to generate one',
    });
  }
  const suggestion = await task('Looking at your project', theme, () =>
    suggestDockerfile(ctx, dir),
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
  process.stderr.write(
    `${theme.paint('warning', theme.glyph('bang'))} No Dockerfile ${sanitize(where)}. This looks like a ${theme.paint('strong', suggestion.label)} project.\n`,
  );
  const go = ctx.io.yes
    ? true
    : await confirm(
        {
          message: `Create a Dockerfile for it?`,
          label: 'Create Dockerfile',
          default: true,
        },
        theme,
      );
  if (!go)
    throw new CliError('cancelled', 'A Dockerfile is needed to deploy.', {
      hint: 'Add one and run this again',
    });
  writeFileSync(abs, suggestion.dockerfile, { flag: 'wx' });
  process.stderr.write(
    `${theme.paint('success', theme.glyph('check'))} Wrote ${sanitize(path.relative(process.cwd(), abs) || 'Dockerfile')} ${theme.paint('muted', '(review and commit it)')}\n`,
  );
}
