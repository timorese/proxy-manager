import { describe, expect, it } from 'vitest';
import { validatePacSource } from '../src/pac/pac-source.ts';

const ok = (s: string) => validatePacSource(s).ok;
const reason = (s: string) => {
  const r = validatePacSource(s);
  return r.ok ? '' : r.reason;
};

describe('validatePacSource (static, no execution)', () => {
  it('accepts typical PAC scripts', () => {
    expect(ok('function FindProxyForURL(url, host) { return "DIRECT"; }')).toBe(true);
    expect(
      ok(`// corp pac
      var proxies = {"a": "PROXY a:1"};
      function FindProxyForURL(url, host) {
        if (shExpMatch(host, "*.corp")) return proxies["a"];
        if (/^\\d+\\.\\d+$/.test(host)) return "DIRECT"; /* regex with braces {[ */
        return "DIRECT";
      }`),
    ).toBe(true);
  });
  it('is not confused by brackets inside strings, comments and regex literals', () => {
    expect(
      ok(
        'function FindProxyForURL(u,h){ var s = "}}}(("; var c = \'{[\'; /* ) */ // }\n return /[})]/.test(h) ? "A" : "DIRECT"; }',
      ),
    ).toBe(true);
  });
  it('division is not a regex', () => {
    expect(ok('function FindProxyForURL(u,h){ var x = (4 / 2) / 1; return "DIRECT"; }')).toBe(true);
  });
  it('rejects empty, HTML error pages and missing entry point', () => {
    expect(reason('   ')).toMatch(/empty/);
    expect(reason('<!DOCTYPE html><html>FindProxyForURL</html>')).toMatch(/HTML/);
    expect(reason('<html><body>502 Bad Gateway</body></html>')).toMatch(/HTML/);
    expect(reason('var x = 1;')).toMatch(/FindProxyForURL/);
  });
  it('rejects truncated downloads', () => {
    expect(ok('function FindProxyForURL(u,h){ return "DIRECT";')).toBe(false);
    expect(ok('function FindProxyForURL(u,h){ return "DIREC')).toBe(false);
    expect(ok('function FindProxyForURL(u,h){ /* cut')).toBe(false);
    expect(ok('function FindProxyForURL(u,h){ )')).toBe(false);
  });
  it('rejects oversized scripts', () => {
    expect(reason(`function FindProxyForURL(){}${' '.repeat(1024 * 1024)}`)).toMatch(/large/);
  });
});
