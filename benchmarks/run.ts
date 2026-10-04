/**
 * `npm run benchmark` — measures the whole pipeline at 100 / 1 000 / 10 000 / 50 000 rules.
 * Pure Node (no browser): numbers for DOM rendering live in benchmarks/browser.mjs.
 * Exits non-zero when a regression threshold (benchmarks/thresholds.json) is exceeded.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { IDBFactory } from 'fake-indexeddb';
import { parseImport } from '../src/domain-rules/import.ts';
import { normalizePattern } from '../src/domain-rules/normalize.ts';
import { compile, normalize, type PacConfig } from '../src/pac/compiler.ts';
import { hashString } from '../src/shared/hash.ts';
import { createRepositories } from '../src/storage/index.ts';
import { makeLookups, makeRules, toText } from './data.ts';
import { strategyComparison } from './strategies.ts';

const SIZES = [100, 1000, 10000, 50000];
const SOURCE = 'function FindProxyForURL(u,h){ return h.endsWith(".corp") ? "PROXY corp:8080" : "DIRECT"; }';

/** median of `runs` timings in ms (first run discarded as warm-up when runs > 2) */
async function time(fn: () => unknown | Promise<unknown>, runs = 5): Promise<number> {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  if (t.length > 2) t.shift();
  t.sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)]!;
}

const fmt = (n: number, d = 2) => Number(n.toFixed(d));

/** Runs the loop *inside* the PAC context so we measure FindProxyForURL, not vm boundary crossings. */
function lookupMicros(pac: string, hosts: string[]): number {
  const ctx = vm.createContext({ performance, hosts, urls: hosts.map((h) => `http://${h}/`), sink: 0 });
  vm.runInContext(pac, ctx);
  const loop = `(function(){var n=hosts.length,t=performance.now(),k=0;for(var r=0;r<20;r++)for(var i=0;i<n;i++)if(FindProxyForURL(urls[i],hosts[i]).length>5)k++;return (performance.now()-t)*1000/(n*20)})()`;
  vm.runInContext(loop, ctx); // warm-up
  return vm.runInContext(loop, ctx) as number;
}

const results: Record<string, Record<string, number>> = {};
const rows: Record<string, number | string>[] = [];

for (const n of SIZES) {
  const rules = makeRules(n);
  const text = toText(rules);
  const look = makeLookups(rules);
  const cfg: PacConfig = {
    mode: 'direct',
    failoverDirect: true,
    bypassLocal: true,
    proxies: [{ id: 'p', scheme: 'socks5', host: '127.0.0.1', port: 1080, enabled: true }],
    rules,
    sources: [{ id: 's', text: SOURCE }],
  };
  const runs = n >= 50000 ? 3 : 5;

  const normMs = await time(() => {
    for (let i = 0; i < rules.length; i++) normalizePattern(rules[i]!.pattern);
  }, runs);
  const importMs = await time(() => parseImport(text), runs);
  const normalized = normalize(cfg);
  const compileOnlyMs = await time(() => compile(normalized), runs);
  const pipelineMs = await time(() => compile(normalize(cfg)), runs);
  const res = compile(normalized);
  const hashMs = await time(() => hashString(res.text), runs);
  const gz = gzipSync(res.text).length;

  const loadMs = await time(() => {
    const ctx = vm.createContext({});
    vm.runInContext(res.text, ctx);
  }, runs);
  const hitUs = lookupMicros(res.text, look.exact);
  const wildUs = lookupMicros(res.text, look.wildSub);
  const missUs = lookupMicros(res.text, look.miss);

  // storage (fake-indexeddb in Node: an in-memory upper-bound-of-overhead stand-in, NOT real Chrome IDB numbers)
  const repos = createRepositories({ get: async () => ({}), set: async () => {} }, new IDBFactory());
  const writeMs = await time(async () => repos.rules.putMany(rules), 3);
  const readMs = await time(async () => repos.rules.getAll(), 3);

  // search/filter: substring scan over the already-normalised patterns
  const patterns = rules.map((r) => r.pattern);
  const searchMs = await time(() => {
    let c = 0;
    for (let i = 0; i < patterns.length; i++) if (patterns[i]!.includes('site1')) c++;
    return c;
  }, 7);
  const sortMs = await time(() => [...patterns].sort(), 3);

  const row = {
    rules: n,
    'normalize ms': fmt(normMs),
    'import parse ms': fmt(importMs),
    'compile ms': fmt(compileOnlyMs),
    'normalize+compile ms': fmt(pipelineMs),
    'hash ms': fmt(hashMs),
    'PAC KB': fmt(res.text.length / 1024, 1),
    'PAC gz KB': fmt(gz / 1024, 1),
    'rules kept': res.rulesCompiled,
    'PAC load ms': fmt(loadMs),
    'lookup exact µs': fmt(hitUs, 3),
    'lookup wildcard µs': fmt(wildUs, 3),
    'lookup miss µs': fmt(missUs, 3),
    'idb write ms*': fmt(writeMs),
    'idb read ms*': fmt(readMs),
    'search ms': fmt(searchMs, 3),
    'sort ms': fmt(sortMs),
  };
  rows.push(row);
  results[String(n)] = {
    normalizeMs: normMs,
    importMs,
    compileMs: compileOnlyMs,
    pipelineMs,
    hashMs,
    pacBytes: res.text.length,
    pacGzBytes: gz,
    loadMs,
    lookupExactUs: hitUs,
    lookupWildcardUs: wildUs,
    lookupMissUs: missUs,
    searchMs,
    sortMs,
  };
}

console.log('\n== Pipeline (Node, this machine) ==');
console.table(rows);
console.log(
  '* fake-indexeddb in Node, not representative of Chrome IndexedDB; see docs/PERFORMANCE.md for browser numbers.\n',
);

console.log('== Lookup strategy comparison @ 10 000 rules (ns per lookup, in-process JS) ==');
const strat = strategyComparison(makeRules(10000), makeLookups(makeRules(10000)));
console.table(strat);

writeFileSync(
  new URL('./results.json', import.meta.url),
  `${JSON.stringify({ node: process.version, results, strategies: strat }, null, 2)}\n`,
);

// ---- regression thresholds ----
const thr = JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8')) as Record<
  string,
  Record<string, number>
>;
const failures: string[] = [];
for (const [size, limits] of Object.entries(thr)) {
  const got = results[size];
  if (!got) continue;
  for (const [metric, max] of Object.entries(limits)) {
    if ((got[metric] ?? Number.POSITIVE_INFINITY) > max)
      failures.push(`${size} rules: ${metric} = ${fmt(got[metric] ?? NaN, 3)} > ${max}`);
  }
}
const small = results['100']!;
const big = results['50000']!;
const scale = big.lookupMissUs! / Math.max(small.lookupMissUs!, 0.001);
console.log(
  `Lookup scaling 100 -> 50 000 rules (miss): x${fmt(scale, 1)} (legacy linear scan: x${fmt(11998 / 5.1, 0)})`,
);
const maxRatio = thr._scaling?.maxMissRatio ?? 12;
if (scale > maxRatio) failures.push(`lookup miss scaling x${fmt(scale, 1)} > x${maxRatio}`);
if (failures.length) {
  console.error(`\nREGRESSION:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll regression thresholds OK.');
