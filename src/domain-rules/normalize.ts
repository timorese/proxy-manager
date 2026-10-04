export type NormalizeResult = { ok: true; pattern: string } | { ok: false; error: string };

const MAX_HOST = 253;
const MAX_LABEL = 63;

/** a-z 0-9 - _ */
function isLabelChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95;
}

/** Returns an error string or '' when `host` is a syntactically valid (already lowercase ASCII) host name. */
export function checkHost(host: string): string {
  const n = host.length;
  if (n === 0) return 'empty host';
  if (n > MAX_HOST) return 'host too long';
  let labelStart = 0;
  for (let i = 0; i <= n; i++) {
    const c = i < n ? host.charCodeAt(i) : 46;
    if (c === 46) {
      const len = i - labelStart;
      if (len === 0) return 'empty label';
      if (len > MAX_LABEL) return 'label too long';
      if (host.charCodeAt(labelStart) === 45 || host.charCodeAt(i - 1) === 45)
        return 'label starts/ends with "-"';
      labelStart = i + 1;
    } else if (!isLabelChar(c)) {
      return `invalid character "${host[i]}"`;
    }
  }
  return '';
}

function toAscii(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
}

/**
 * Canonical form of a user supplied rule pattern.
 *   "Example.COM."            -> "example.com"
 *   "*.Example.com"           -> "*.example.com"
 *   ".example.com"            -> "*.example.com"
 *   "https://a.b.com:8080/x"  -> "a.b.com"
 *   "пример.рф"               -> "xn--e1afmkfd.xn--p1ai"
 * Hot path: no regex, no allocation for already-canonical input apart from the trim/lowercase.
 */
export function normalizePattern(input: string): NormalizeResult {
  let s = input.trim().toLowerCase();
  if (s.length === 0) return { ok: false, error: 'empty' };

  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) {
      s = s.slice(0, i);
      break;
    }
  }
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  const colon = s.lastIndexOf(':');
  if (colon >= 0 && s.indexOf(':') === colon) {
    // host:port -> drop the port (single colon only; IPv6 is not supported as a rule)
    s = s.slice(0, colon);
  }

  let wildcard = false;
  if (s.charCodeAt(0) === 42) {
    if (s.charCodeAt(1) !== 46) return { ok: false, error: 'wildcard must be "*."' };
    wildcard = true;
    s = s.slice(2);
  } else if (s.charCodeAt(0) === 46) {
    wildcard = true;
    s = s.slice(1);
  }
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 46) end--;
  if (end !== s.length) s = s.slice(0, end);

  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) {
      s = toAscii(s);
      break;
    }
  }
  const err = checkHost(s);
  if (err) return { ok: false, error: err };
  return { ok: true, pattern: wildcard ? `*.${s}` : s };
}

export const isWildcard = (pattern: string): boolean => pattern.charCodeAt(0) === 42;
/** Host part of a normalised pattern. */
export const patternHost = (pattern: string): string =>
  pattern.charCodeAt(0) === 42 ? pattern.slice(2) : pattern;
