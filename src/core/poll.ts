import { CliError } from './errors';

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  label?: string;
}

const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 600_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntil<T>(
  check: () => Promise<T | null>,
  opts: PollOptions = {},
): Promise<T> {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline)
      throw new CliError(
        'timeout',
        `Timed out waiting${opts.label ? ` for ${opts.label}` : ''}`,
      );
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
}
