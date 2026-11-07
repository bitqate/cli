import type { Readable, Writable } from 'node:stream';
import { CliError } from '../core/errors';
import type { Theme } from './theme';
import { claimInput, guardEngaged } from './input-guard';

export type Key =
  | { name: 'up' | 'down' | 'left' | 'right' | 'enter' | 'backspace' }
  | { name: 'cancel' }
  | { name: 'char'; ch: string };

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export function cancelled(): never {
  throw new CliError('cancelled', 'Cancelled.');
}

const CSI_KEYS: Record<string, Key['name']> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
};

export class KeyParser {
  private pending = '';
  private pasting = false;
  private escTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly emit: (k: Key) => void) {}

  feed(chunk: Buffer | string): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = undefined;
    }
    const s = this.pending + chunk.toString();
    this.pending = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        const used = this.escape(s, i);
        if (used === 0) {
          this.pending = s.slice(i);
          this.escTimer = setTimeout(() => this.flushEscape(), 30);
          return;
        }
        i += used;
        continue;
      }
      this.plain(ch);
      i++;
    }
  }

  private flushEscape(): void {
    this.escTimer = undefined;
    if (this.pending === '\x1b') this.emit({ name: 'cancel' });
    this.pending = '';
  }

  private escape(s: string, i: number): number {
    if (i + 1 >= s.length) return 0;
    const next = s[i + 1];
    if (next === '[') {
      let j = i + 2;
      while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f)
        j++;
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f)
        j++;
      if (j >= s.length) return 0;
      const final = s[j];
      const params = s.slice(i + 2, j);
      if (final === '~' && params === '200') this.pasting = true;
      else if (final === '~' && params === '201') this.pasting = false;
      else if (!this.pasting) {
        const key = CSI_KEYS[final];
        if (key) this.emit({ name: key } as Key);
      }
      return j - i + 1;
    }
    if (next === 'O') {
      if (i + 2 >= s.length) return 0;
      const key = CSI_KEYS[s[i + 2]];
      if (key && !this.pasting) this.emit({ name: key } as Key);
      return 3;
    }
    if (next === '\x1b') {
      if (!this.pasting) this.emit({ name: 'cancel' });
      return 1;
    }
    return 2;
  }

  private plain(ch: string): void {
    if (this.pasting) {
      if (ch >= ' ' && ch !== '\x7f') this.emit({ name: 'char', ch });
      return;
    }
    if (ch === '\x03' || ch === '\x04') this.emit({ name: 'cancel' });
    else if (ch === '\r' || ch === '\n') this.emit({ name: 'enter' });
    else if (ch === '\x7f' || ch === '\x08') this.emit({ name: 'backspace' });
    else if (ch >= ' ') this.emit({ name: 'char', ch });
  }

  close(): void {
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = undefined;
    this.pending = '';
  }
}

export interface PromptIO {
  input: Readable;
  output: Writable;
}

class KeyReader {
  private onData: (b: Buffer) => void;
  private parser: KeyParser;
  private release?: () => void;
  private closed = false;
  constructor(
    private readonly io: PromptIO,
    emit: (k: Key) => void,
  ) {
    this.parser = new KeyParser((k) => {
      if (!this.closed) emit(k);
    });
    this.onData = (b: Buffer) => this.parser.feed(b);
    if (io.input === process.stdin) this.release = claimInput();
    const anyInput = io.input as any;
    if (anyInput.setRawMode) anyInput.setRawMode(true);
    if (anyInput.resume) anyInput.resume();
    io.input.on('data', this.onData);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.parser.close();
    const anyInput = this.io.input as any;
    this.io.input.off('data', this.onData);
    if (this.release) {
      this.release();
      if (guardEngaged()) return;
    }
    if (anyInput.setRawMode) anyInput.setRawMode(false);
    if (anyInput.pause) anyInput.pause();
  }
}

const ANSI = new RegExp('\\x1b\\[[0-9;?]*[A-Za-z]', 'g');

function visualRows(line: string, columns: number): number {
  const width = line.replace(ANSI, '').length;
  return Math.max(1, Math.ceil(width / Math.max(1, columns)));
}

class Frame {
  rows = 0;
  constructor(private readonly io: PromptIO) {}

  private columns(): number {
    const cols = (this.io.output as any).columns;
    return typeof cols === 'number' && cols > 0 ? cols : 80;
  }

  write(lines: string[]) {
    this.clear();
    this.io.output.write(`${lines.join('\n')}\n`);
    const cols = this.columns();
    this.rows = lines.reduce((n, l) => n + visualRows(l, cols), 0);
  }

  clear() {
    if (!this.rows) return;
    this.io.output.write(`\x1b[${this.rows}A\r\x1b[J`);
    this.rows = 0;
  }
}

export interface SelectOption<T = string> {
  label: string;
  value: T;
  hint?: string;
}

export interface SelectOpts<T = string> {
  message: string;
  label?: string;
  initial?: number;
  options: SelectOption<T>[];
  io?: PromptIO;
}

export function select<T>(opts: SelectOpts<T>, theme: Theme): Promise<T> {
  const io = opts.io ?? { input: process.stdin, output: process.stderr };
  const filterable = opts.options.length > 7;
  const frame = new Frame(io);
  let index = Math.max(0, Math.min(opts.initial ?? 0, opts.options.length - 1));
  let offset = index >= 8 ? index - 7 : 0;
  let filter = '';
  const filtered = () =>
    filter
      ? opts.options.filter((o) =>
          o.label.toLowerCase().includes(filter.toLowerCase()),
        )
      : opts.options;

  const paint = (t: 'muted' | 'strong' | 'success' | 'danger', s: string) =>
    theme.paint(t, s);
  const pointer = theme.glyph('pointer');

  const rows = () => {
    const list = filtered();
    const q = filterable
      ? ` ${paint('muted', `(${filter || 'type to filter'})`)}`
      : '';
    const lines = [`${paint('strong', '?')} ${opts.message}${q}`];
    const visible = list.slice(offset, offset + 8);
    const hintAt = Math.max(...visible.map((o) => o.label.length), 0) + 4;
    visible.forEach((o, i) => {
      const active = offset + i === index;
      const showHint = o.hint && o.hint !== o.label;
      const hint = showHint
        ? ' '.repeat(Math.max(1, hintAt - o.label.length)) +
          paint('muted', o.hint!)
        : '';
      lines.push(
        `${active ? paint('success', pointer) : ' '} ${o.label}${hint}`,
      );
    });
    if (!list.length) lines.push(`  ${paint('muted', 'no matches')}`);
    return lines;
  };

  io.output.write(HIDE_CURSOR);
  const reader = new KeyReader(io, (k) => {
    const list = filtered();
    if (k.name === 'cancel') {
      reader.close();
      frame.clear();
      io.output.write(SHOW_CURSOR);
      fail(new CliError('cancelled', 'Cancelled.'));
      return;
    }
    if (k.name === 'enter') {
      const item = list[index];
      if (!item) return;
      reader.close();
      frame.clear();
      io.output.write(
        `${paint('success', theme.glyph('check'))} ${opts.label ?? opts.message}  ${paint('muted', item.label)}\n${SHOW_CURSOR}`,
      );
      done(item.value);
      return;
    }
    if (k.name === 'up') index = Math.max(0, index - 1);
    else if (k.name === 'down') index = Math.min(list.length - 1, index + 1);
    else if (k.name === 'char' && !filterable && k.ch === 'j')
      index = Math.min(list.length - 1, index + 1);
    else if (k.name === 'char' && !filterable && k.ch === 'k')
      index = Math.max(0, index - 1);
    else if (k.name === 'char' && filterable) {
      filter += k.ch;
      index = 0;
    } else if (k.name === 'backspace' && filter) {
      filter = filter.slice(0, -1);
      index = 0;
    }
    if (index < offset) offset = index;
    if (index >= offset + 8) offset = index - 7;
    frame.write(rows());
  });

  let done!: (v: T) => void;
  let fail!: (e: Error) => void;
  const result = new Promise<T>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  frame.write(rows());
  return result;
}

export function text(
  opts: {
    message: string;
    label?: string;
    blankLabel?: string;
    default?: string;
    validate?: (v: string) => string | null;
    io?: PromptIO;
  },
  theme: Theme,
): Promise<string> {
  const io = opts.io ?? { input: process.stdin, output: process.stderr };
  const frame = new Frame(io);
  let value = '';
  let error: string | null = null;
  const paint = theme.paint.bind(theme);

  const rows = () => {
    const def = opts.default ? ` ${paint('muted', `(${opts.default})`)}` : '';
    const lines = [`${paint('strong', '?')} ${opts.message}${def} ${value}`];
    if (error)
      lines.push(
        `  ${paint('danger', theme.glyph('bang'))} ${paint('danger', error)}`,
      );
    return lines;
  };

  let done!: (v: string) => void;
  let fail!: (e: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  const reader = new KeyReader(io, (k) => {
    if (k.name === 'cancel') {
      reader.close();
      frame.clear();
      fail(new CliError('cancelled', 'Cancelled.'));
      return;
    }
    if (k.name === 'enter') {
      const v = value || (opts.default ?? '');
      const err = opts.validate ? opts.validate(v) : null;
      if (err) {
        error = err;
        frame.write(rows());
        return;
      }
      reader.close();
      frame.clear();
      io.output.write(
        `${paint('success', theme.glyph('check'))} ${opts.label ?? opts.message}  ${paint('muted', v || (opts.blankLabel ?? 'none'))}\n`,
      );
      done(v);
      return;
    }
    if (k.name === 'backspace') value = value.slice(0, -1);
    else if (k.name === 'char') value += k.ch;
    error = null;
    frame.write(rows());
  });
  frame.write(rows());
  return result;
}

export function confirm(
  opts: {
    message: string;
    label?: string;
    answerText?: string;
    default?: boolean;
    io?: PromptIO;
  },
  theme: Theme,
): Promise<boolean> {
  const io = opts.io ?? { input: process.stdin, output: process.stderr };
  const paint = theme.paint.bind(theme);
  const suffix = opts.default === false ? '[y/N]' : '[Y/n]';
  io.output.write(
    `${paint('strong', '?')} ${opts.message} ${paint('muted', suffix)} `,
  );
  let done!: (v: boolean) => void;
  let fail!: (e: Error) => void;
  const result = new Promise<boolean>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  const reader = new KeyReader(io, (k) => {
    if (k.name === 'cancel') {
      reader.close();
      io.output.write('\n');
      fail(new CliError('cancelled', 'Cancelled.'));
      return;
    }
    if (k.name === 'enter') {
      const v = opts.default !== false;
      reader.close();
      io.output.write(
        `\r\x1b[K${paint('success', theme.glyph('check'))} ${opts.label ?? opts.message}  ${paint('muted', opts.answerText ?? (v ? 'yes' : 'no'))}\n`,
      );
      done(v);
      return;
    }
    if (k.name === 'char') {
      const c = k.ch.toLowerCase();
      if (c === 'y' || c === 'n') {
        const v = c === 'y';
        reader.close();
        io.output.write(
          `\r\x1b[K${paint('success', theme.glyph('check'))} ${opts.label ?? opts.message}  ${paint('muted', opts.answerText ?? (v ? 'yes' : 'no'))}\n`,
        );
        done(v);
      }
    }
  });
  return result;
}

export function password(
  opts: { message: string; io?: PromptIO },
  theme: Theme,
): Promise<string> {
  const io = opts.io ?? { input: process.stdin, output: process.stderr };
  const paint = theme.paint.bind(theme);
  let value = '';
  const render = () => {
    io.output.write(
      `\r\x1b[K${paint('strong', '?')} ${opts.message} ${theme.glyph('bullet').repeat(value.length)}`,
    );
  };
  io.output.write(`${paint('strong', '?')} ${opts.message} `);
  let done!: (v: string) => void;
  let fail!: (e: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  const reader = new KeyReader(io, (k) => {
    if (k.name === 'cancel') {
      reader.close();
      io.output.write('\n');
      fail(new CliError('cancelled', 'Cancelled.'));
      return;
    }
    if (k.name === 'enter') {
      reader.close();
      io.output.write('\n');
      done(value);
      return;
    }
    if (k.name === 'backspace') value = value.slice(0, -1);
    else if (k.name === 'char') value += k.ch;
    render();
  });
  return result;
}
