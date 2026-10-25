import type { CliError } from './errors';
import type { Table } from '../ui/table';
import { renderTable } from '../ui/table';
import type { Theme } from '../ui/theme';
import { makeTheme } from '../ui/theme';

const C0_C1 = new RegExp('[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]', 'g');

export function sanitize(value: string): string {
  return value.replace(C0_C1, '');
}

export function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out;
  }
  return value;
}

export interface Detail {
  title?: string;
  id?: string;
  fields: [string, unknown][];
  hints?: [string, string][];
}

export type Renderable =
  | { lines: string[] }
  | { table: Table }
  | { detail: Detail };

export function isRenderable(v: Renderable): v is Renderable {
  return 'lines' in v || 'table' in v || 'detail' in v;
}

export function kvLines(data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value === null) lines.push(`${key}: -`);
    else if (typeof value === 'object')
      lines.push(`${key}: ${JSON.stringify(sanitizeDeep(value))}`);
    else lines.push(`${key}: ${sanitize(String(value))}`);
  }
  return lines;
}

export function detailToLines(
  detail: Detail,
  theme: Theme,
  tty: boolean,
): string[] {
  const lines: string[] = [];
  if (detail.title) lines.push(detail.title);
  if (detail.id) lines.push(theme.paint('muted', detail.id));
  if (detail.title || detail.id) lines.push('');
  const w = Math.max(...detail.fields.map(([l]) => l.length), 1);
  for (const [label, value] of detail.fields) {
    if (value === undefined || value === null || value === '') continue;
    const text =
      typeof value === 'object'
          ? JSON.stringify(sanitizeDeep(value))
          : sanitize(String(value));
    lines.push(`  ${theme.paint('muted', label.padEnd(w))}  ${text}`);
  }
  if (tty && detail.hints?.length) {
    lines.push('');
    const hw = Math.max(...detail.hints.map(([c]) => c.length));
    for (const [cmd, desc] of detail.hints)
      lines.push(
        `  ${theme.paint('strong', cmd.padEnd(hw))}  ${theme.paint('muted', desc)}`,
      );
  }
  return lines;
}

export function printRenderable(
  renderable: Renderable,
  ui: { theme: Theme; interactive: boolean; tty?: boolean },
): void {
  const tty = ui.tty ?? ui.interactive;
  if ('table' in renderable) {
    process.stdout.write(
      `${renderTable(renderable.table, ui.theme, { tty })}\n`,
    );
    return;
  }
  if ('detail' in renderable) {
    for (const line of detailToLines(renderable.detail, ui.theme, tty))
      process.stdout.write(`${line}\n`);
    return;
  }
  for (const line of renderable.lines)
    process.stdout.write(`${sanitize(line)}\n`);
}

export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function printQuiet(data: unknown): void {
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (item && typeof item === 'object' && 'id' in item)
      process.stdout.write(`${sanitize(String((item as any).id))}\n`);
    else if (typeof item === 'string' || typeof item === 'number')
      process.stdout.write(`${sanitize(String(item))}\n`);
  }
}

export function errorHint(err: CliError): string | null {
  if (err.hint) return err.hint;
  if (err.code === 'unauthenticated') return 'Run bitqate auth login';
  if (err.code === 'forbidden') {
    const scope = /missing the (\S+) scope/.exec(err.message)?.[1];
    return `Create a token${scope ? ` with the ${scope} scope` : ''} at https://portal.bitqate.com/settings?tab=api`;
  }
  if (err.code === 'payment_required')
    return 'Top up at https://portal.bitqate.com/billing';
  if (err.code === 'rate_limited')
    return `Try again in ${err.retryAfter ?? 30}s`;
  if (err.code === 'network') return 'Check your connection';
  return null;
}

export function printError(err: CliError, json: boolean, theme?: Theme): void {
  if (json) {
    const payload: Record<string, unknown> = {
      code: err.code,
      message: sanitize(err.message),
    };
    if (err.status !== undefined) payload.status = err.status;
    if (err.retryAfter !== undefined) payload.retry_after = err.retryAfter;
    process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
    return;
  }
  const t = theme ?? makeTheme(0, true);
  const glyph = t.paint('danger', t.glyph('cross'));
  process.stderr.write(`${glyph} ${sanitize(err.message)}\n`);
  const hint = errorHint(err);
  if (hint) process.stderr.write(`  ${t.paint('muted', hint)}\n`);
}
