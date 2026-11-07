const SHOW_CURSOR = '\x1b[?25h';
const DISABLE_PASTE = '\x1b[?2004l';

type Stdin = NodeJS.ReadStream & {
  setRawMode?: (mode: boolean) => unknown;
  isRaw?: boolean;
};

let engaged = false;
let claimed = 0;
let suspended = false;
let exitHooked = false;

function stdin(): Stdin {
  return process.stdin as Stdin;
}

function onGuardData(chunk: Buffer): void {
  if (claimed || suspended) return;
  const s = chunk.toString('utf8');
  if (!s.includes('\x03')) return;
  if (process.listenerCount('SIGINT') > 0) {
    process.emit('SIGINT');
    return;
  }
  restoreTerminal();
  process.stderr.write('\n');
  process.exit(130);
}

function setRaw(on: boolean): void {
  const input = stdin();
  if (!input.isTTY || typeof input.setRawMode !== 'function') return;
  try {
    input.setRawMode(on);
  } catch {}
}

export function restoreTerminal(): void {
  if (process.stdin.isTTY) {
    setRaw(false);
    try {
      process.stdin.pause();
    } catch {}
  }
  if (process.stderr.isTTY) process.stderr.write(SHOW_CURSOR);
}

export function engageInputGuard(): void {
  if (engaged) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) return;
  engaged = true;
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      if (engaged) restoreTerminal();
    });
  }
  if (process.stderr.isTTY) process.stderr.write(DISABLE_PASTE);
  setRaw(true);
  stdin().on('data', onGuardData);
  stdin().resume();
}

export function releaseInputGuard(): void {
  if (!engaged) return;
  engaged = false;
  stdin().off('data', onGuardData);
  restoreTerminal();
}

export function claimInput(): () => void {
  claimed++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    claimed--;
    if (engaged && !suspended) {
      setRaw(true);
      stdin().resume();
    }
  };
}

export function guardEngaged(): boolean {
  return engaged;
}

export async function withTerminalReleased<T>(
  fn: () => Promise<T>,
): Promise<T> {
  if (!engaged) return fn();
  suspended = true;
  stdin().off('data', onGuardData);
  setRaw(false);
  stdin().pause();
  try {
    return await fn();
  } finally {
    suspended = false;
    if (engaged) {
      setRaw(true);
      stdin().on('data', onGuardData);
      stdin().resume();
    }
  }
}
