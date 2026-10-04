import { describe, expect, it } from 'vitest';
import { makeLookups, makeRules, toText } from '../benchmarks/data.ts';
import { parseImport } from '../src/domain-rules/import.ts';
import { compile, normalize, type PacConfig } from '../src/pac/compiler.ts';
import { loadPac } from './helpers/pac-runner.ts';

/**
 * Regression guards. Size limits are deterministic (exact generator + compiler => exact bytes) and tight;
 * time limits are deliberately generous (~5-10x the measured value) so CI noise cannot flake them,
 * while an accidental O(N^2) or O(N)-per-lookup change still trips them.
 * Full numbers + thresholds: `npm run benchmark` (benchmarks/thresholds.json).
 */
const cfg = (n: number, rules = makeRules(n)): PacConfig => ({
  mode: 'direct',
  failoverDirect: true,
  bypassLocal: true,
  proxies: [{ id: 'p', scheme: 'socks5', host: '127.0.0.1', port: 1080, enabled: true }],
  rules,
  sources: [],
});

describe.each([
  [100, 1_300, 200],
  [1000, 9_500, 300],
  [10_000, 95_000, 600],
  [50_000, 480_000, 2_000],
])('%i rules', (n, maxBytes, maxCompileMs) => {
  const rules = makeRules(n);
  const c = cfg(n, rules);
  it(`PAC <= ${maxBytes} bytes, compile+normalize <= ${maxCompileMs} ms`, () => {
    const t = performance.now();
    const res = compile(normalize(c));
    const ms = performance.now() - t;
    console.log(
      `  ${n} rules -> ${res.text.length} B PAC (${res.rulesCompiled} kept), compile ${ms.toFixed(1)} ms`,
    );
    expect(res.text.length).toBeLessThanOrEqual(maxBytes);
    expect(ms).toBeLessThan(maxCompileMs);
  });
  it('lookup cost does not depend on the number of rules', () => {
    const res = compile(normalize(c));
    const f = loadPac(res.text);
    const look = makeLookups(rules, 500);
    const hosts = [...look.exact, ...look.wildSub, ...look.miss];
    const t = performance.now();
    for (let r = 0; r < 4; r++) for (const h of hosts) f(`http://${h}/`, h);
    const us = ((performance.now() - t) * 1000) / (hosts.length * 4);
    console.log(`  ${n} rules: ${us.toFixed(2)} µs / lookup (incl. vm call overhead)`);
    expect(us).toBeLessThan(25); // legacy: 12 000 µs at 50k
  });
});

it('importing 50 000 lines parses in well under a second', () => {
  const text = toText(makeRules(50_000));
  const t = performance.now();
  const r = parseImport(text);
  expect(r.rules.length).toBeGreaterThan(40_000);
  expect(performance.now() - t).toBeLessThan(1500);
});
