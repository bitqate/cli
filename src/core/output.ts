import type { CliError } from './errors';

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

export interface TableSpec {
  head: string[];
  rows: string[][];
}

export type Renderable = { lines: string[] } | { table: TableSpec };

export function isRenderable(v: Renderable): v is Renderable {
  return 'lines' in v || 'table' in v;
}

export function printError(err: CliError, json: boolean): void {
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
  process.stderr.write(`error: ${sanitize(err.message)}\n`);
  if (err.hint) process.stderr.write(`hint: ${sanitize(err.hint)}\n`);
}

export function kvLines(data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value === null) {
      lines.push(`${key}: -`);
    } else if (typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(sanitizeDeep(value))}`);
    } else {
      lines.push(`${key}: ${sanitize(String(value))}`);
    }
  }
  return lines;
}

export function printRenderable(renderable: Renderable): void {
  if ('table' in renderable) {
    printTable(renderable.table);
    return;
  }
  for (const line of renderable.lines)
    process.stdout.write(`${sanitize(line)}\n`);
}

export function printTable(table: TableSpec): void {
  const rows = table.rows.map((row) => row.map(sanitize));
  const head = table.head.map(sanitize);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cols: string[]) =>
    cols
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  process.stdout.write(`${fmt(head)}\n`);
  for (const row of rows) process.stdout.write(`${fmt(row)}\n`);
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

export function colorize(enabled: boolean) {
  const wrap = (code: string) => (s: string) =>
    enabled ? `\x1b[${code}m${sanitize(s)}\x1b[0m` : sanitize(s);
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    green: wrap('32'),
    yellow: wrap('33'),
    red: wrap('31'),
  };
}
