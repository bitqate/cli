import { describe, expect, test } from 'bun:test';
import { KeyParser, type Key } from '../src/ui/prompts';

function parse(...chunks: string[]): Key[] {
  const keys: Key[] = [];
  const p = new KeyParser((k) => keys.push(k));
  for (const c of chunks) p.feed(c);
  p.close();
  return keys;
}

const chars = (keys: Key[]) =>
  keys
    .filter((k): k is { name: 'char'; ch: string } => k.name === 'char')
    .map((k) => k.ch)
    .join('');

describe('KeyParser', () => {
  test('arrow keys in CSI and SS3 form', () => {
    expect(parse('\x1b[A\x1b[B\x1bOC\x1bOD').map((k) => k.name)).toEqual([
      'up',
      'down',
      'right',
      'left',
    ]);
  });

  test('unknown escape sequences never leak characters', () => {
    expect(chars(parse('\x1b[3~\x1b[1;5C\x1b[200;1R\x1b[?1;2c\x1b[15~'))).toBe(
      '',
    );
  });

  test('a sequence split across chunks is reassembled', () => {
    expect(parse('\x1b', '[', 'B').map((k) => k.name)).toEqual(['down']);
    expect(chars(parse('\x1b[2', '01~ok'))).toBe('ok');
  });

  test('bracketed paste delivers only the pasted text', () => {
    const keys = parse('\x1b[200~bqat_abc\r\n\x1b[201~');
    expect(chars(keys)).toBe('bqat_abc');
    expect(keys.some((k) => k.name === 'enter')).toBe(false);
  });

  test('alt+key and double escape do not insert text', () => {
    expect(chars(parse('\x1bx'))).toBe('');
    expect(parse('\x1b\x1b').map((k) => k.name)).toEqual(['cancel']);
  });

  test('a lone escape cancels after a short pause', async () => {
    const keys: Key[] = [];
    const p = new KeyParser((k) => keys.push(k));
    p.feed('\x1b');
    expect(keys).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(keys.map((k) => k.name)).toEqual(['cancel']);
  });

  test('control characters map to keys, others are dropped', () => {
    expect(parse('a\x7f\r\x03\x01').map((k) => k.name)).toEqual([
      'char',
      'backspace',
      'enter',
      'cancel',
    ]);
  });
});
