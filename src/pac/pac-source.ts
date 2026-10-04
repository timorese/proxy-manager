/**
 * Static sanity check for third-party PAC text. We never execute it in the extension context
 * (no eval / new Function). The text is only embedded as data into the PAC handed to chrome.proxy,
 * which Chrome runs in its own sandboxed PAC interpreter.
 *
 * The goal is to reject the *common* corruptions (HTML error page, truncated download, empty body)
 * so one bad download can never break the combined PAC. It is a lexical check, not a JS parser.
 */
export const MAX_PAC_SOURCE_BYTES = 1024 * 1024;

export type SourceCheck = { ok: true } | { ok: false; reason: string };

const REGEX_PREV_WORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'throw',
  'new',
  'else',
  'do',
]);
const REGEX_PREV_CHARS = '(,=:[!&|?{};+-*%<>~^';

export function validatePacSource(text: string): SourceCheck {
  if (text.length === 0 || text.trim().length === 0) return { ok: false, reason: 'empty script' };
  if (text.length > MAX_PAC_SOURCE_BYTES) return { ok: false, reason: 'script too large' };
  const head = text.trimStart().slice(0, 64).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    return { ok: false, reason: 'looks like HTML, not a PAC script' };
  }
  if (!text.includes('FindProxyForURL')) return { ok: false, reason: 'FindProxyForURL is not defined' };

  const stack: number[] = [];
  const n = text.length;
  let prevChar = 0; // last significant (non-space, non-comment) char
  let prevWord = '';
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) {
      i++;
      continue;
    }
    if (c === 47) {
      const d = text.charCodeAt(i + 1);
      if (d === 47) {
        const e = text.indexOf('\n', i + 2);
        i = e < 0 ? n : e + 1;
        continue;
      }
      if (d === 42) {
        const e = text.indexOf('*/', i + 2);
        if (e < 0) return { ok: false, reason: 'unterminated comment (truncated?)' };
        i = e + 2;
        continue;
      }
      const regexAllowed =
        prevChar === 0 ||
        REGEX_PREV_CHARS.includes(String.fromCharCode(prevChar)) ||
        REGEX_PREV_WORDS.has(prevWord);
      if (regexAllowed) {
        let inClass = false;
        i++;
        for (; i < n; i++) {
          const r = text.charCodeAt(i);
          if (r === 92) i++;
          else if (r === 10) return { ok: false, reason: 'unterminated regular expression' };
          else if (r === 91) inClass = true;
          else if (r === 93) inClass = false;
          else if (r === 47 && !inClass) break;
        }
        if (i >= n) return { ok: false, reason: 'unterminated regular expression' };
        i++;
        prevChar = 47;
        prevWord = '';
        continue;
      }
      prevChar = c;
      prevWord = '';
      i++;
      continue;
    }
    if (c === 34 || c === 39 || c === 96) {
      i++;
      for (; i < n; i++) {
        const s = text.charCodeAt(i);
        if (s === 92) i++;
        else if (s === c) break;
        else if (s === 10 && c !== 96) return { ok: false, reason: 'unterminated string' };
      }
      if (i >= n) return { ok: false, reason: 'unterminated string (truncated?)' };
      i++;
      prevChar = c;
      prevWord = '';
      continue;
    }
    if (c === 40 || c === 91 || c === 123) {
      stack.push(c === 40 ? 41 : c === 91 ? 93 : 125);
    } else if (c === 41 || c === 93 || c === 125) {
      if (stack.pop() !== c) return { ok: false, reason: 'unbalanced brackets' };
    }
    const isWordChar =
      (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36;
    if (isWordChar) {
      let j = i + 1;
      while (j < n) {
        const w = text.charCodeAt(j);
        if ((w >= 97 && w <= 122) || (w >= 65 && w <= 90) || (w >= 48 && w <= 57) || w === 95 || w === 36)
          j++;
        else break;
      }
      prevWord = text.slice(i, j);
      prevChar = text.charCodeAt(j - 1);
      i = j;
      continue;
    }
    prevChar = c;
    prevWord = '';
    i++;
  }
  if (stack.length > 0) return { ok: false, reason: 'unbalanced brackets (truncated?)' };
  return { ok: true };
}
