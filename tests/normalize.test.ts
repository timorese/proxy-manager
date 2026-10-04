import { describe, expect, it } from 'vitest';
import { normalizePattern } from '../src/domain-rules/normalize.ts';

const ok = (s: string) => {
  const r = normalizePattern(s);
  return r.ok ? r.pattern : `ERR:${r.error}`;
};

describe('normalizePattern', () => {
  it('lowercases, trims and strips trailing dots', () => {
    expect(ok('  Example.COM.  ')).toBe('example.com');
    expect(ok('example.com...')).toBe('example.com');
  });
  it('keeps wildcards and converts leading dot', () => {
    expect(ok('*.Example.com')).toBe('*.example.com');
    expect(ok('.example.com')).toBe('*.example.com');
  });
  it('extracts host from URLs', () => {
    expect(ok('https://User:pw@A.b.com:8080/path?x=1#h')).toBe('a.b.com');
    expect(ok('example.com:443')).toBe('example.com');
  });
  it('punycodes IDN', () => {
    expect(ok('пример.рф')).toBe('xn--e1afmkfd.xn--p1ai');
  });
  it('accepts single labels and IPv4', () => {
    expect(ok('localhost')).toBe('localhost');
    expect(ok('10.0.0.1')).toBe('10.0.0.1');
  });
  it.each([
    '',
    '*',
    '*example.com',
    'a..b',
    '-a.com',
    'a-.com',
    'exa mple.com',
    'a b/c',
    'a_b.com!',
    `${'a'.repeat(64)}.com`,
  ])('rejects %j', (s) => {
    expect(ok(s).startsWith('ERR:')).toBe(true);
  });
  it('is idempotent', () => {
    for (const s of ['Example.com.', '.a.b.c', 'https://X.y/z']) {
      const once = ok(s);
      expect(ok(once)).toBe(once);
    }
  });
});
