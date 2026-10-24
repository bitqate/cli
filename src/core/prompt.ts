import { createInterface } from 'node:readline';
import { usageError } from './errors';

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY)
    throw usageError(
      'No terminal available; pass the token with --token-stdin instead.',
    );
  process.stderr.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      cleanup();
      fn();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          finish(() => resolve(buf));
          return;
        }
        if (ch === '\x03') {
          finish(() => {
            process.stderr.write('\n');
            process.exit(130);
          });
          return;
        }
        if (ch === '\x04') {
          finish(() => resolve(buf));
          return;
        }
        if (ch === '\x7f' || ch === '\x08') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    const onError = (err: Error) => finish(() => reject(err));
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('error', onError);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('error', onError);
  });
}

export async function confirmResourceId(expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Type '${expected}' to confirm: `, (a) => resolve(a));
    });
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}
