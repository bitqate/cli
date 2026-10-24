import { CliError, usageError } from './errors';
import { text } from '../ui/prompts';
import { pollUntil, type PollOptions } from './poll';
import { isInteractive } from '../ui/spinner';
import { sanitize } from './output';
import type { RunContext } from '../registry';

export async function confirmDestroy(
  ctx: RunContext,
  name: string,
): Promise<void> {
  if (ctx.io.yes || ctx.flags['dry-run']) return;
  if (ctx.io.json || !ctx.io.interactive)
    throw new CliError('usage', 'This action is destructive.', {
      hint: 'pass --yes to confirm',
    });
  process.stderr.write(
    `This will permanently destroy ${sanitize(name)} and its data.\n`,
  );
  const typed = await text(
    { message: `Type '${name}' to confirm` },
    ctx.io.theme,
  );
  if (typed !== name) throw usageError('Confirmation did not match; aborted.');
}

export async function waitPoll<T>(
  label: { name: string; kind: 'vms' | 'servers' },
  check: () => Promise<{ value: T | null; status: string }>,
  opts: PollOptions = {},
): Promise<T> {
  let lastStatus = 'unknown';
  let onSigint: (() => void) | null = null;
  const work = pollUntil(async () => {
    const r = await check();
    lastStatus = r.status;
    return r.value;
  }, opts);
  const cancelled = new Promise<never>((_, reject) => {
    if (!isInteractive()) return;
    onSigint = () => {
      reject(
        new CliError(
          'cancelled',
          `Stopped waiting. ${label.name} is still ${lastStatus}. Check with bitqate ${label.kind} get ${label.name}`,
        ),
      );
    };
    process.once('SIGINT', onSigint);
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    if (onSigint) process.off('SIGINT', onSigint);
  }
}
