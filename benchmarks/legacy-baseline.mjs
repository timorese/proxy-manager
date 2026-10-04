// Baseline of the ORIGINAL implementation's PAC generator (ilyachase/pac-proxy-manager-extension).
// Usage: LEGACY_DIR=/path/to/clone node benchmarks/legacy-baseline.mjs
// Skips silently when LEGACY_DIR is not set (the legacy code is not vendored here).

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const dir = process.env.LEGACY_DIR;
if (!dir) {
  console.log('LEGACY_DIR not set; skipping legacy baseline');
  process.exit(0);
}
globalThis.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}) } } };
globalThis.indexedDB = {
  open() {
    return {};
  },
};
const { ProxyManager } = await import(pathToFileURL(`${dir}/src/utils/proxyManager.js`).href);
const pm = new ProxyManager();

const proxies = [{ url: 'socks5://127.0.0.1:1080' }];
const mk = (n) => {
  const o = {};
  for (let i = 0; i < n; i++)
    o[`${i % 5 === 0 ? '*.' : ''}host${i}.example${i % 97}.com`] = i % 3 ? 'yes' : 'no';
  return o;
};
const rows = [];
for (const n of [100, 1000, 10000, 50000]) {
  const ex = mk(n);
  const t0 = performance.now();
  const pac = pm.generateCombinedPacScript(ex, proxies, [], true, true);
  const gen = performance.now() - t0;
  const t1 = performance.now();
  const ctx = vm.createContext({});
  vm.runInContext(pac, ctx);
  const load = performance.now() - t1;
  // lookup: worst case (miss -> wildcard scan over all keys)
  const f = ctx.FindProxyForURL;
  const N = 2000;
  const t2 = performance.now();
  for (let i = 0; i < N; i++) f(`http://nohit${i}.org/`, `nohit${i}.org`);
  const miss = ((performance.now() - t2) / N) * 1000;
  const t3 = performance.now();
  for (let i = 0; i < N; i++) f('http://x/', `host${i % n}.example${(i % n) % 97}.com`);
  const hit = ((performance.now() - t3) / N) * 1000;
  rows.push({
    rules: n,
    genMs: +gen.toFixed(1),
    loadMs: +load.toFixed(1),
    pacKB: +(pac.length / 1024).toFixed(0),
    missUs: +miss.toFixed(1),
    exactHitUs: +hit.toFixed(1),
  });
}
console.table(rows);
