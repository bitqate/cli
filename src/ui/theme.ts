export type ColorLevel = 0 | 1 | 3;

export type Tone =
  | 'success'
  | 'progress'
  | 'warning'
  | 'danger'
  | 'muted'
  | 'strong';

const TRUECOLOR: Record<Exclude<Tone, 'strong'>, string> = {
  success: '38;2;16;185;129',
  progress: '38;2;59;130;246',
  warning: '38;2;245;158;11',
  danger: '38;2;239;68;68',
  muted: '38;2;168;162;158',
};

const ANSI16: Record<Exclude<Tone, 'strong'>, string> = {
  success: '32',
  progress: '34',
  warning: '33',
  danger: '31',
  muted: '90',
};

const GLYPHS = {
  dot: ['●', '*'],
  check: ['✓', '+'],
  cross: ['✗', 'x'],
  pointer: ['›', '>'],
  bang: ['!', '!'],
  middot: ['·', '-'],
  ellipsis: ['…', '...'],
  bullet: ['•', '*'],
} as const;

export type GlyphName = keyof typeof GLYPHS;

const SPINNER_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_ASCII = ['-', '\\', '|', '/'];

export interface Theme {
  level: ColorLevel;
  unicode: boolean;
  paint(tone: Tone, s: string): string;
  glyph(name: GlyphName): string;
  spinnerFrames(): string[];
  statusTone(status: string): Tone;
}

const STATUS_TONES: Record<string, Tone> = {
  running: 'success',
  online: 'success',
  active: 'success',
  installed: 'success',
  success: 'success',
  completed: 'success',
  creating: 'progress',
  starting: 'progress',
  stopping: 'progress',
  restarting: 'progress',
  reinstalling: 'progress',
  installing: 'progress',
  building: 'progress',
  pending: 'progress',
  stopped: 'muted',
  offline: 'muted',
  not_installed: 'muted',
  unknown: 'muted',
  suspended: 'warning',
  error: 'danger',
  failed: 'danger',
};

export function detectLevel(stream: { isTTY?: boolean }): ColorLevel {
  const env = process.env;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    const n = Number(force);
    if (n === 0) return 0;
    if (n === 1) return 1;
    if (n >= 2) return 3;
  }
  if (env.NO_COLOR) return 0;
  if (env.TERM === 'dumb') return 0;
  if (!stream.isTTY) return 0;
  const termProgram = env.TERM_PROGRAM ?? '';
  if (
    env.COLORTERM === 'truecolor' ||
    env.COLORTERM === '24bit' ||
    env.WT_SESSION ||
    termProgram === 'iTerm.app' ||
    termProgram === 'vscode' ||
    termProgram === 'WezTerm'
  ) {
    return 3;
  }
  return 1;
}

export function useUnicode(): boolean {
  const env = process.env;
  if (env.TERM === 'dumb') return false;
  if (process.platform === 'win32' && !env.WT_SESSION && !env.TERM_PROGRAM)
    return false;
  return true;
}

export function makeTheme(level: ColorLevel, unicode: boolean): Theme {
  const paint = (tone: Tone, s: string): string => {
    if (!level || !s) return s;
    if (tone === 'strong') return `\x1b[1m${s}\x1b[22m`;
    const code = level === 3 ? TRUECOLOR[tone] : ANSI16[tone];
    return `\x1b[${code}m${s}\x1b[0m`;
  };
  return {
    level,
    unicode,
    paint,
    glyph: (name) => GLYPHS[name][unicode ? 0 : 1],
    spinnerFrames: () => (unicode ? SPINNER_UNICODE : SPINNER_ASCII),
    statusTone: (status) => STATUS_TONES[status] ?? 'muted',
  };
}

export function statusText(theme: Theme, status: string): string {
  return `${theme.paint(theme.statusTone(status), theme.glyph('dot'))} ${status}`;
}
