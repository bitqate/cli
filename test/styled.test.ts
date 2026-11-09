import { describe, expect, test } from 'bun:test';
import { sanitizeStyled } from '../src/core/output';

describe('sanitizeStyled', () => {
  test('keeps SGR colour codes', () => {
    const painted = '[38;2;16;185;129m✓[0m Logged out.';
    expect(sanitizeStyled(painted)).toBe(painted);
    expect(sanitizeStyled('[32mgreen[0m plain')).toBe('[32mgreen[0m plain');
  });
  test('strips BEL and OSC hyperlinks', () => {
    expect(sanitizeStyled('ok\x07bell')).toBe('okbell');
    expect(sanitizeStyled('a\x1b]8;;http://x\x07link')).toBe('alink');
    expect(sanitizeStyled('\x1b[31mred\x1b[0m\x1b]8;;http://x\x07')).toBe(
      '\x1b[31mred\x1b[0m',
    );
  });
  test('plain text unchanged, C1 stripped', () => {
    expect(sanitizeStyled('plain text')).toBe('plain text');
    expect(sanitizeStyled('a\x9fb')).toBe('ab');
    expect(sanitizeStyled('x\x1b[2Jy')).toBe('xy');
  });
});
