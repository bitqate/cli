import { usageError } from './errors';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unescapeDq(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const n = s[++i];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === '"') out += '"';
      else if (n === '\\') out += '\\';
      else out += n;
    } else {
      out += ch;
    }
  }
  return out;
}

// Parses a dotenv file. Supports `export `, comment lines, inline ` #`
// comments on unquoted values, single-quoted literals, double-quoted
// escapes (\n \t \" \\) spanning multiple lines, trimmed unquoted values
// and empty values.
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const lineNo = ++i;
    let line = lines[i - 1];
    const t = line.trimStart();
    if (!t || t.startsWith('#')) continue;
    line = line.replace(/^\s*export\s+/, '');
    const eq = line.indexOf('=');
    if (eq < 0) throw usageError(`Line ${lineNo}: expected KEY=VALUE`);
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      throw usageError(`Line ${lineNo}: invalid variable name "${key}"`);
    }
    const rest = line.slice(eq + 1).trimStart();
    if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) throw usageError(`Line ${lineNo}: unterminated quote`);
      out[key] = rest.slice(1, end);
      continue;
    }
    if (rest.startsWith('"')) {
      // Scan for the closing quote, continuing onto following lines.
      let value = rest.slice(1);
      let closed = false;
      for (;;) {
        const closeIdx = findClosingQuote(value);
        if (closeIdx >= 0) {
          out[key] = unescapeDq(value.slice(0, closeIdx));
          closed = true;
          break;
        }
        if (i >= lines.length) break;
        value += '\n' + lines[i++];
      }
      if (!closed) throw usageError(`Line ${lineNo}: unterminated quote`);
      continue;
    }
    const hash = rest.search(/\s#/);
    out[key] = (hash >= 0 ? rest.slice(0, hash) : rest).trimEnd();
  }
  return out;
}

// Index of the first unescaped '"' in s, or -1.
function findClosingQuote(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}
