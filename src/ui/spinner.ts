import { CliError } from '../core/errors';
import { elapsed } from './format';
import type { Theme } from './theme';

const SHOW_AFTER_MS = 120;
const FRAME_MS = 80;
const ELAPSED_AFTER_S = 3;

export interface TaskHandle {
  update(text: string): void;
}

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export class Spinner {
  private timer?: ReturnType<typeof setInterval>;
  private delay?: ReturnType<typeof setTimeout>;
  private frame = 0;
  private label: string;
  private extra = '';
  private started = Date.now();
  private visible = false;
  private stopped = false;

  constructor(
    label: string,
    private readonly theme: Theme,
    private readonly out: NodeJS.WriteStream = process.stderr,
  ) {
    this.label = label;
    this.delay = setTimeout(() => this.show(), SHOW_AFTER_MS);
  }

  private show() {
    if (this.stopped) return;
    this.visible = true;
    this.out.write(HIDE_CURSOR);
    this.timer = setInterval(() => this.render(), FRAME_MS);
    this.render();
  }

  private render() {
    const frames = this.theme.spinnerFrames();
    const f = this.theme.paint(
      'progress',
      frames[this.frame++ % frames.length],
    );
    const secs = (Date.now() - this.started) / 1000;
    const tail = secs >= ELAPSED_AFTER_S ? ` ${elapsed(secs)}` : '';
    const extra = this.extra
      ? `  ${this.theme.paint('muted', this.extra)}`
      : '';
    this.out.write(`\r\x1b[K${f} ${this.label}${extra}${tail}`);
  }

  update(extra: string) {
    this.extra = extra;
  }

  stop(kind: 'ok' | 'fail' | 'clear', finalLabel?: string) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.delay) clearTimeout(this.delay);
    if (this.timer) clearInterval(this.timer);
    if (this.visible) {
      this.out.write(`\r\x1b[K${SHOW_CURSOR}`);
      if (kind === 'ok')
        this.out.write(
          `${this.theme.paint('success', this.theme.glyph('check'))} ${finalLabel ?? this.label}\n`,
        );
      else if (kind === 'fail')
        this.out.write(
          `${this.theme.paint('danger', this.theme.glyph('cross'))} ${finalLabel ?? this.label}\n`,
        );
    }
  }
}

export function isInteractive(): boolean {
  return !!(process.stdin.isTTY && process.stderr.isTTY) && !process.env.CI;
}

export async function task<T>(
  label: string,
  theme: Theme,
  fn: (t: TaskHandle) => Promise<T>,
  opts: { interactive?: boolean; endStyle?: 'ok' | 'clear' | 'fail' } = {},
): Promise<T> {
  const interactive = opts.interactive ?? isInteractive();
  if (!interactive) return fn({ update: () => {} });
  const sp = new Spinner(label, theme);
  try {
    const out = await fn(sp);
    sp.stop(opts.endStyle ?? 'clear');
    return out;
  } catch (err) {
    sp.stop(
      err instanceof CliError && err.code === 'cancelled' ? 'clear' : 'fail',
    );
    throw err;
  }
}
