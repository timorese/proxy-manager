// Real-Chromium IndexedDB layout experiment (why rules are stored in 256 buckets, see docs/PERFORMANCE.md).
// A = one record per rule, B = 256 buckets of arrays (shipped), C = 256 buckets of text lines.
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
const dist = new URL('../dist', import.meta.url).pathname; // any built extension page gives us a real-Chrome IndexedDB
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'x-')), {
  executablePath:
    process.env.CHROMIUM_PATH ??
    join(
      '/opt/pw-browsers',
      readdirSync('/opt/pw-browsers').find((x) => /^chromium-\d+$/.test(x)),
      'chrome-linux',
      'chrome',
    ),
  headless: false,
  args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
const id = new URL(sw.url()).host;
const p = await ctx.newPage();
await p.goto(`chrome-extension://${id}/popup/popup.html`);
const res = await p.evaluate(async () => {
  const open = (name, stores) =>
    new Promise((res, rej) => {
      indexedDB.deleteDatabase(name);
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        for (const s of stores) r.result.createObjectStore(s.n, s.o);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const done = (tx) =>
    new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  const out = {};
  for (const N of [10000, 50000]) {
    const rules = Array.from({ length: N }, (_, i) => ({
      pattern: `${i % 7 ? '' : '*.'}host${i}.site${i % 997}.com`,
      action: ['proxy', 'direct', 'pac'][i % 3],
      enabled: i % 11 !== 0,
    }));
    // A: per-record put
    let db = await open('a', [{ n: 'r', o: { keyPath: 'pattern' } }]);
    let t = performance.now();
    let tx = db.transaction('r', 'readwrite');
    const s = tx.objectStore('r');
    let sync = performance.now();
    for (const r of rules) s.put(r);
    const syncA = performance.now() - sync;
    await done(tx);
    const wA = performance.now() - t;
    t = performance.now();
    await new Promise((res) => {
      const rq = db.transaction('r').objectStore('r').getAll();
      rq.onsuccess = () => res(rq.result);
    });
    const rA = performance.now() - t;
    db.close();
    // B: buckets of arrays
    const B = 256;
    const hash = (s) => {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0) % B;
    };
    db = await open('b', [{ n: 'r', o: { keyPath: 'id' } }]);
    t = performance.now();
    const buckets = Array.from({ length: B }, (_, id) => ({ id, rules: [] }));
    for (const r of rules) buckets[hash(r.pattern)].rules.push(r);
    tx = db.transaction('r', 'readwrite');
    sync = performance.now();
    for (const b of buckets) tx.objectStore('r').put(b);
    const syncB = performance.now() - sync;
    await done(tx);
    const wB = performance.now() - t;
    t = performance.now();
    const gb = await new Promise((res) => {
      const rq = db.transaction('r').objectStore('r').getAll();
      rq.onsuccess = () => res(rq.result);
    });
    const flat = gb.flatMap((b) => b.rules);
    const rB = performance.now() - t;
    db.close();
    // C: buckets of text
    db = await open('c', [{ n: 'r', o: { keyPath: 'id' } }]);
    t = performance.now();
    const tb = Array.from({ length: B }, () => []);
    for (const r of rules) tb[hash(r.pattern)].push(`${r.enabled ? 1 : 0}${r.action[0]}${r.pattern}`);
    tx = db.transaction('r', 'readwrite');
    sync = performance.now();
    for (const [id, l] of tb.entries()) tx.objectStore('r').put({ id, text: l.join('\n') });
    const syncC = performance.now() - sync;
    await done(tx);
    const wC = performance.now() - t;
    t = performance.now();
    const gc = await new Promise((res) => {
      const rq = db.transaction('r').objectStore('r').getAll();
      rq.onsuccess = () => res(rq.result);
    });
    const acts = { p: 'proxy', d: 'direct', a: 'pac' };
    const flat2 = [];
    for (const b of gc)
      for (const l of b.text.split('\n'))
        flat2.push({ pattern: l.slice(2), action: acts[l[1]], enabled: l[0] === '1' });
    const rC = performance.now() - t;
    db.close();
    out[N] = {
      A_put_sync_ms: syncA | 0,
      A_write_total_ms: wA | 0,
      A_read_ms: rA | 0,
      B_put_sync_ms: syncB | 0,
      B_write_total_ms: wB | 0,
      B_read_ms: rB | 0,
      C_put_sync_ms: syncC | 0,
      C_write_total_ms: wC | 0,
      C_read_ms: rC | 0,
      n: flat.length + flat2.length,
    };
  }
  return out;
});
console.log(JSON.stringify(res, null, 1));
await ctx.close();
