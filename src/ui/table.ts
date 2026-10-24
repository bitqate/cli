import { sanitize } from '../core/output';
import { truncate } from './format';
import type { Theme } from './theme';

export interface TableColumn {
  title: string;
  priority?: number;
  minWidth?: number;
  truncate?: boolean;
}

export interface Table {
  columns: TableColumn[];
  rows: string[][];
  footer?: string;
}

const GAP = 2;
const ANSI_RE = new RegExp('\\x1b\\[[0-9;]*m', 'g');

function visible(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function plain(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function renderTable(
  table: Table,
  theme: Theme,
  opts: { tty: boolean; width?: number },
): string {
  const { columns, rows } = table;
  let keep = columns.map((_, i) => i);

  const raw = (r: string[], i: number) => sanitize(plain(r[i] ?? ''));

  if (!opts.tty) {
    const lines = [
      columns
        .map((c) => c.title)
        .join(' '.repeat(GAP))
        .trimEnd(),
      ...rows.map((r) =>
        keep
          .map((i) => raw(r, i))
          .join(' '.repeat(GAP))
          .trimEnd(),
      ),
    ];
    if (table.footer) lines.push(sanitize(table.footer));
    return lines.join('\n');
  }

  const width = opts.width ?? process.stdout.columns ?? 80;

  const naturalWidths = (cols: number[]) =>
    cols.map((i) =>
      Math.max(
        columns[i].title.length,
        columns[i].minWidth ?? 0,
        ...rows.map((r) => visible(r[i] ?? '')),
      ),
    );

  let widths = naturalWidths(keep);
  const total = () =>
    widths.reduce((a, b) => a + b, 0) + GAP * (keep.length - 1);

  while (keep.length > 2 && total() > width) {
    const drop = keep
      .slice(1)
      .reduce((worst, i) =>
        (columns[i].priority ?? 0) <= (columns[worst].priority ?? 0)
          ? i
          : worst,
      );
    keep = keep.filter((i) => i !== drop);
    widths = naturalWidths(keep);
  }

  while (total() > width) {
    const truncIdx = keep.findIndex((i) => columns[i].truncate);
    const idx = truncIdx >= 0 ? truncIdx : 0;
    if (widths[idx] <= (columns[keep[idx]].minWidth ?? 4)) break;
    widths[idx]--;
  }

  const line = (cells: string[], isHeader: boolean) =>
    keep
      .map((i, j) => {
        const w = widths[j];
        const cell = isHeader ? theme.paint('muted', cells[i]) : cells[i];
        const pad = w - visible(cells[i]);
        return pad > 0 ? cell + ' '.repeat(pad) : cell;
      })
      .join(' '.repeat(GAP))
      .trimEnd();

  const lines = [
    line(
      columns.map((c) => c.title.toUpperCase()),
      true,
    ),
    ...rows.map((r) => {
      const cells = keep.map((i, j) => {
        const cell = r[i] ?? '';
        return columns[i].truncate || j === 0
          ? truncate(cell, widths[j])
          : cell;
      });
      const padded: string[] = [];
      for (const i of keep) padded[i] = cells[keep.indexOf(i)];
      return line(padded, false);
    }),
  ];
  if (table.footer) lines.push(theme.paint('muted', table.footer));
  return lines.join('\n');
}
