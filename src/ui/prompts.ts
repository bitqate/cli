import type { Readable, Writable } from 'node:stream';
import { CliError } from '../core/errors';
import type { Theme } from './theme';

export type Key =
  | { name: 'up' | 'down' | 'left' | 'right' | 'enter' | 'backspace' }
  | { name: 'cancel' }
  | { name: 'char'; ch: string };

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export function cancelled(): never {
  throw new CliError('cancelled', 'Cancelled.');
}

function parseKeys(chunk: Buffer, emit: (k: Key) => void): void {
  const s = chunk.toString('utf8');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\x1b') {
      const seq = s.slice(i, i + 3);
      if (seq === '\x1b[A') emit({ name: 'up' });
      else if (seq === '\x1b[B') emit({ name: 'down' });
      else if (seq === '\x1b[C') emit({ name: 'right' });
      else if (seq === '\x1b[D') emit({ name: 'left' });
      else if (i + 1 >= s.length || s[i + 1] !== '[') emit({ name: 'cancel' });
      if (seq.startsWith('\x1b[') && seq.length === 3) i += 2;
      continue;
    }
    if (ch === '\x03' || ch === '\x04') {
      emit({ name: 'cancel' });
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      emit({ name: 'enter' });
      continue;
    }
    if (ch === '\x7f' || ch === '\x08') {
      emit({ name: 'backspace' });
      continue;
    }
    if (ch >= ' ') emit({ name: 'char', ch });
  }
}

export interface PromptIO {
  input: Readable;
  output: Writable;
}

class KeyReader {
  private onData: (b: Buffer) => void;
  constructor(
    private readonly io: PromptIO,
    emit: (k: Key) => void,
  ) {
    this.onData = (b: Buffer) => parseKeys(b, emit);
    const anyInput = io.input as any;
    if (anyInput.setRawMode) anyInput.setRawMode(true);
    if (anyInput.resume) anyInput.resume();
    io.input.on('data', this.onData);
  }

  close() {
    const anyInput = this.io.input as any;
    this.io.input.off('data', this.onData);
    if (anyInput.setRawMode) anyInput.setRawMode(false);
    if (anyInput.pause) anyInput.pause();
  }
}

class Frame {
  lines = 0;
  constructor(private readonly io: PromptIO) {}

  write(lines: string[]) {
    this.clear();
    this.io.output.write(`${lines.join('\n')}\n`);
    this.lines = lines.length;
  }

  clear() {
    if (!this.lines) return;
    this.io.output.write(`\x1b[${this.lines}F\x1b[J`);
    this.lines = 0;
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
  options: SelectOption<T>[];
  io?: PromptIO;
}

export function select<T>(
  opts: SelectOpts<T>,
  theme: Theme,
): Promise<T> {
  const io = opts.io ?? { input: process.stdin, output: process.stderr };
  const filterable = opts.options.length > 7;
  const frame = new Frame(io);
  let index = 0;
  let offset = 0;
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
    else if (k.name === 'char' && k.ch === 'j')
      index = Math.min(list.length - 1, index + 1);
    else if (k.name === 'char' && k.ch === 'k') index = Math.max(0, index - 1);
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
