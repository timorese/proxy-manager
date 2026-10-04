// Real-Chromium end-to-end check + popup benchmark.
//   node benchmarks/browser.mjs                 (needs `npm run build` first)
//   LEGACY_DIR=/path/to/legacy node ...         (adds the legacy popup cold-open for comparison)
// Requires Playwright + a Chromium binary (CHROMIUM_PATH or the Playwright-managed one).

import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
}
const { chromium } = pw;
const dist = resolve(import.meta.dirname, '../dist');
const exe =
  process.env.CHROMIUM_PATH ??
  (() => {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
    const d = readdirSync(base).find((x) => /^chromium-\d+$/.test(x));
    return join(base, d, 'chrome-linux', 'chrome');
  })();

const hits = [];
const proxy = http.createServer((req, res) => {
  hits.push(req.url);
  res.setHeader('content-type', 'text/html');
  res.end('<title>via-proxy</title>via-proxy');
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const PORT = proxy.address().port;

async function launch(extDir) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ppm-')), {
    executablePath: exe,
    headless: false,
    args: [
      '--headless=new',
      '--no-sandbox',
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
  });
  let sw = ctx.serviceWorkers()[0];
  sw ??= await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  for (
    let i = 0;
    i < 40 && !(await sw.evaluate(() => Boolean(globalThis.chrome?.runtime?.id)).catch(() => false));
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  return { ctx, sw, id: new URL(sw.url()).host };
}

const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
  if (!c) process.exitCode = 1;
};
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// Mirrors src/storage/idb.ts (bucketOf + ruleBuckets layout); tests/storage.test.ts pins bucketOf so drift is caught.
const seed = (page, n) =>
  page.evaluate(async (n) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('ppm2', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('ruleBuckets', { keyPath: 'id' });
        r.result.createObjectStore('pacs', { keyPath: 'id' });
        r.result.createObjectStore('pacBodies');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const bucketOf = (s) => {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0) % 256;
    };
    const buckets = Array.from({ length: 256 }, (_, id) => ({ id, rules: [] }));
    for (let i = 0; i < n; i++) {
      const pattern = `${i % 7 ? '' : '*.'}host${i}.site${i % 997}.com`;
      buckets[bucketOf(pattern)].rules.push({
        pattern,
        action: ['proxy', 'direct', 'pac'][i % 3],
        enabled: i % 11 !== 0,
      });
    }
    const tx = db.transaction('ruleBuckets', 'readwrite');
    const s = tx.objectStore('ruleBuckets');
    s.clear();
    for (const b of buckets) if (b.rules.length) s.put(b);
    await new Promise((res) => (tx.oncomplete = res));
    db.close();
  }, n);

// ---------------------------------------------------------------------------------------------
console.log(`Chromium: ${exe}\n`);
const { ctx, sw, id } = await launch(dist);
const popupUrl = `chrome-extension://${id}/popup/popup.html`;
const errors = [];
ctx.on('weberror', (e) => errors.push(String(e.error())));

// ---- 1. End-to-end behaviour -----------------------------------------------------------------
console.log('== End-to-end (real Chrome: chrome.proxy + PAC) ==');
const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
ok(manifest.manifest_version === 3, 'Chrome loaded the MV3 manifest, service worker started');
ok(
  JSON.stringify(manifest.permissions) === JSON.stringify(['proxy', 'storage', 'alarms', 'activeTab']),
  'permissions are exactly proxy/storage/alarms/activeTab',
);

await sw.evaluate(() => {
  // count real chrome.proxy.settings.set calls
  const o = chrome.proxy.settings.set.bind(chrome.proxy.settings);
  self.__sets = 0;
  chrome.proxy.settings.set = (...a) => {
    self.__sets++;
    return o(...a);
  };
});
/** evaluate in whichever service worker instance is currently alive (Chrome may restart it at any time) */
const swEval = async (fn, arg) => {
  for (let i = 0; i < 30; i++) {
    const w = ctx.serviceWorkers().at(-1);
    try {
      if (w) return await w.evaluate(fn, arg);
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no live service worker');
};
const sets = () => swEval(() => self.__sets ?? 0);

const page = await ctx.newPage();
await page.goto(popupUrl);
await page.waitForSelector('#power:not([disabled])');
await page.fill('input[placeholder^="socks5"]', `http://127.0.0.1:${PORT}`);
await page.press('input[placeholder^="socks5"]', 'Enter');
await page.click('button[data-tab="rules"]');
await page.fill('input[aria-label="New rule"]', 'proxied.example');
await page.selectOption('select[aria-label="Action for new rule"]', 'proxy');
await page.click('button:has-text("Add")');
await page.click('button[data-tab="proxy"]');
await page.click('#power');
await page.waitForFunction(() => document.querySelector('.badge')?.textContent === 'ACTIVE', null, {
  timeout: 10000,
});
const cfg = await sw.evaluate(() => chrome.proxy.settings.get({ incognito: false }));
ok(
  cfg.value.mode === 'pac_script' && cfg.value.pacScript.data.includes('proxied.example'),
  `chrome.proxy has the compiled PAC (${cfg.value.pacScript?.data.length} bytes), level=${cfg.levelOfControl}`,
);
const afterEnable = await sets();
ok(afterEnable >= 1, `settings.set called ${afterEnable}x to enable`);

const p2 = await ctx.newPage();
await p2.goto('http://proxied.example/', { timeout: 10000 }).catch(() => {});
ok(
  (await p2.title()) === 'via-proxy' && hits.some((u) => u.startsWith('http://proxied.example/')),
  'rule PROXY: request reached the proxy',
);
hits.length = 0;
const direct = await p2
  .goto('http://unlisted.example/', { timeout: 8000 })
  .then(() => 'loaded')
  .catch((e) =>
    String(e.message).includes('ERR_NAME_NOT_RESOLVED') ? 'dns-fail' : String(e.message).slice(0, 60),
  );
ok(
  !hits.some((u) => u.includes('unlisted.example')) && direct === 'dns-fail',
  `unlisted host went DIRECT (did not touch the proxy; result: ${direct})`,
);

// no-op edits must not re-apply: add a redundant rule (new revision, identical PAC)
await page.click('button[data-tab="rules"]');
await page.fill('input[aria-label="New rule"]', 'redundant.example');
await page.selectOption('select[aria-label="Action for new rule"]', 'direct'); // equals the default mode -> compiled away
await page.click('button:has-text("Add")');
await page.waitForTimeout(1200);
ok(
  (await sets()) === afterEnable,
  'redundant rule -> new revision but identical PAC hash -> settings.set NOT called again',
);
// real change applies once
await page.fill('input[aria-label="New rule"]', 'second.example');
await page.selectOption('select[aria-label="Action for new rule"]', 'proxy');
await page.click('button:has-text("Add")');
await page.waitForTimeout(1200);
ok((await sets()) === afterEnable + 1, 'real change -> exactly one settings.set');

// worker restart: terminate SW, state must be recovered from storage
await swEval(() => chrome.storage.local.get('state')).then((s) =>
  ok(s.state.appliedHash.length === 16, `applied hash persisted outside the worker (${s.state.appliedHash})`),
);
const cdp = await ctx.newCDPSession(page);
try {
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.waitForTimeout(500);
  const live = ctx.serviceWorkers().length;
  console.log(`      (service workers alive after stopAllWorkers: ${live})`);
} catch (e) {
  console.log('      (could not stop worker via CDP:', String(e.message).slice(0, 80), ')');
}
// Extension pages can read chrome.storage / chrome.proxy too, so verify through the popup page (the SW handle changes on restart).
const inPage = (fn, arg) => page.evaluate(fn, arg);
await page.click('button[data-tab="proxy"]');
await page.fill('input[placeholder^="socks5"]', `http://127.0.0.1:${PORT + 1}`);
await page.press('input[placeholder^="socks5"]', 'Enter');
await page
  .waitForFunction(
    async () => {
      const r = await chrome.storage.local.get(['rev', 'state']);
      return r.state?.appliedRev === r.rev;
    },
    null,
    { timeout: 8000 },
  )
  .then(
    () =>
      ok(
        true,
        'edit made right after stopAllWorkers: worker (re)started by the storage event and applied the config',
      ),
    () => ok(false, 'worker did not catch up after being stopped'),
  );
const after = await inPage(() => chrome.storage.local.get('state'));
ok(
  after.state.appliedKind === 'pac' && after.state.errors.length === 0,
  'state is consistent after restart (no errors)',
);
const p3 = await ctx.newPage();
hits.length = 0;
await p3.goto('http://proxied.example/', { timeout: 10000 }).catch(() => {});
ok(hits.length > 0, 'routing still works after worker restart');

// Current-site card: which route applies + one-click "add to list" (?site= is the test hook for the active-tab lookup)
{
  const sp = await ctx.newPage();
  await sp.goto(`${popupUrl}?site=proxied.example`);
  await sp.waitForSelector('.card:has-text("Current site") .badge');
  const badge = () => sp.textContent('.card:has-text("Current site") .badge');
  const via = () => sp.textContent('.card:has-text("Current site") .small.muted:not(:has(*))');
  ok((await badge()) === 'PROXY', 'site card: proxied.example shows PROXY');
  ok(
    ((await sp.textContent('.card:has-text("Current site")')) ?? '').includes('rule proxied.example'),
    'site card: names the matching rule',
  );
  await sp.goto(`${popupUrl}?site=www.newsite.example`);
  await sp.waitForSelector('.card:has-text("Current site") .badge');
  ok(
    (await badge()) === 'DIRECT' &&
      ((await sp.textContent('.card:has-text("Current site")')) ?? '').includes('default (direct mode)'),
    'site card: unlisted site shows DIRECT via default mode',
  );
  await sp.click('.card:has-text("Current site") button[data-action="proxy"]');
  await sp.waitForFunction(
    () =>
      [...document.querySelectorAll('.card')]
        .find((c) => c.textContent?.includes('Current site'))
        ?.querySelector('.badge')?.textContent === 'PROXY',
    null,
    {
      timeout: 5000,
    },
  );
  ok(
    ((await sp.textContent('.card:has-text("Current site")')) ?? '').includes('rule *.newsite.example'),
    'site card: "Add to list -> Proxy" created *.newsite.example (www stripped) and the card updated',
  );
  await sp.click('button[data-tab="rules"]');
  await sp.fill('input[type=search]', 'newsite');
  await sp.waitForSelector('.vl-row:not([hidden]) .domain:has-text("*.newsite.example")');
  ok(true, 'rule appears in the Rules tab (list reloaded after being changed from Home)');
  void via;
  await sp.close();
}

// master switch off releases control
await page.click('#power');
await page.waitForFunction(() => document.querySelector('.badge')?.textContent === 'OFF', null, {
  timeout: 8000,
});
const off = await inPage(() => chrome.proxy.settings.get({ incognito: false }));
ok(
  off.levelOfControl === 'controllable_by_this_extension',
  `OFF clears proxy control (level=${off.levelOfControl})`,
);
await page.close();
await p2.close();
await p3.close();

// Remote PAC source through the UI: download, conditional refresh (304), alarm, routing via the third-party PAC.
{
  let conditional = 0;
  let requests = 0;
  const pacSrv = http.createServer((req, res) => {
    requests++;
    if (req.headers['if-none-match'] === '"v1"') {
      conditional++;
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader('etag', '"v1"');
    res.setHeader('access-control-allow-origin', '*'); // headless Chromium cannot answer the optional-permission prompt
    res.setHeader('content-type', 'application/x-ns-proxy-autoconfig');
    res.end(
      `function FindProxyForURL(u,h){ return h==="viapac.example" ? "PROXY 127.0.0.1:${PORT}" : "DIRECT"; }`,
    );
  });
  await new Promise((r) => pacSrv.listen(0, '127.0.0.1', r));
  const pp = await ctx.newPage();
  await pp.goto(popupUrl);
  await pp.waitForSelector('#power:not([disabled])');
  await pp.click('button[data-tab="pac"]');
  await pp.click('button:has-text("+ Add")');
  await pp.fill('input[aria-label="Name"]', 'Local PAC');
  await pp.fill('input[aria-label="PAC URL"]', `http://127.0.0.1:${pacSrv.address().port}/p.pac`);
  await pp.selectOption('.card select >> nth=1', '15');
  await pp.click('button:has-text("Save")');
  await pp.waitForSelector('.list .item:has-text("Updated just now")', { timeout: 10000 });
  ok(requests === 1, 'PAC URL source downloaded exactly once, by the worker');
  const alarm = await pp.evaluate(() => chrome.alarms.get('pac-refresh'));
  ok(
    alarm?.periodInMinutes === 15,
    `chrome.alarms has one refresh alarm (period ${alarm?.periodInMinutes} min), no setInterval`,
  );
  await pp.click('button:has-text("Update")');
  await pp.waitForFunction(
    () => document.querySelector('.small.muted[aria-live]')?.textContent?.includes('up to date'),
    null,
    { timeout: 8000 },
  );
  ok(conditional === 1, 'manual Update sent If-None-Match and the 304 was handled without a rebuild');
  const rev1 = await pp.evaluate(async () => (await chrome.storage.local.get('rev')).rev);
  await pp.click('button[data-tab="proxy"]');
  await pp.click('.seg button:has-text("PAC")');
  if (!(await pp.isChecked('#power'))) await pp.click('#power');
  await pp.waitForFunction(() => document.querySelector('.badge')?.textContent === 'ACTIVE', null, {
    timeout: 10000,
  });
  const via = await ctx.newPage();
  hits.length = 0;
  await via.goto('http://viapac.example/', { timeout: 10000 }).catch(() => {});
  ok(
    hits.some((u) => u.includes('viapac.example')),
    'mode PAC: third-party PAC source decided the route (PROXY)',
  );
  hits.length = 0;
  await via.goto('http://other-pac.example/', { timeout: 8000 }).catch(() => {});
  ok(
    !hits.some((u) => u.includes('other-pac.example')),
    'mode PAC: third-party PAC said DIRECT for another host',
  );
  void rev1;
  // pacSrv now goes offline: Update must fail gracefully, keep working config, and show the error
  pacSrv.close();
  pacSrv.closeAllConnections?.();
  await pp.click('button[data-tab="pac"]');
  await pp.click('button:has-text("Update")');
  await pp.waitForSelector('.badge.err', { timeout: 20000 });
  hits.length = 0;
  await via.goto('http://viapac.example/', { timeout: 10000 }).catch(() => {});
  ok(
    hits.some((u) => u.includes('viapac.example')),
    'offline PAC source: error shown, last good script still routes',
  );
  await pp.click('button[data-tab="proxy"]');
  await pp.waitForSelector('.alert:has-text("PAC fetch failed")', { timeout: 5000 }).then(
    () => ok(true, 'Home shows "PAC fetch failed"'),
    () => ok(false, 'Home shows "PAC fetch failed"'),
  );
  await pp.click('#power');
  await pp.waitForFunction(() => document.querySelector('.badge')?.textContent === 'OFF', null, {
    timeout: 8000,
  });
  await via.close();
  await pp.close();
}

// ---- 2. Popup benchmarks ---------------------------------------------------------------------
console.log('\n== Popup benchmark (headless Chromium, this machine) ==');
const rows = [];
for (const n of [0, 1000, 10000, 50000]) {
  const t = await ctx.newPage();
  await t.goto(popupUrl);
  await t.waitForSelector('#power:not([disabled])');
  await seed(t, n);
  await t.close();

  const cold = [];
  const rulesOpen = [];
  let dom = 0;
  let search = 0;
  let selAllMs = 0;
  let longest = 0;
  for (let run = 0; run < 5; run++) {
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      localStorage.setItem('tab', 'proxy'); // cold-open the home tab regardless of the last visited one
      window.__long = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration);
      }).observe({ entryTypes: ['longtask'] });
    });
    await p.goto(popupUrl, { waitUntil: 'commit' });
    await p.waitForFunction(
      () =>
        !document.querySelector('#power')?.disabled &&
        document.querySelector('.status dd .badge')?.textContent,
    );
    cold.push(await p.evaluate(() => performance.now()));
    const t0 = Date.now();
    await p.click('button[data-tab="rules"]');
    await p.waitForFunction(
      (n) =>
        n === 0
          ? document.querySelector('.vl-empty:not([hidden])')
          : document.querySelector('.vl-row:not([hidden])'),
      n,
    );
    rulesOpen.push(Date.now() - t0);
    if (run === 4) {
      await p.waitForTimeout(150);
      dom = await p.evaluate(() => document.getElementsByTagName('*').length);
      // search latency: set value, dispatch input, wait until the count label shows the filtered total
      search = await p.evaluate(async () => {
        const i = document.querySelector('input[type=search]');
        const s = performance.now();
        i.value = 'site99';
        i.dispatchEvent(new Event('input'));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return performance.now() - s;
      });
      await p.fill('input[type=search]', '');
      await p.waitForTimeout(100);
      // select all + bulk disable: UI + one IDB transaction + one storage write
      selAllMs =
        n === 0
          ? 0
          : await p.evaluate(async () => {
              const sa = document.querySelector('.table-head input[type=checkbox]');
              sa.click();
              const s = performance.now();
              const btn = [...document.querySelectorAll('.bulk button')].find(
                (b) => b.textContent === 'Disable',
              );
              btn.click();
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
              return performance.now() - s;
            });
      longest = await p.evaluate(() => window.__long);
    }
    await p.close();
  }
  rows.push({
    rules: n,
    'cold open ms (median)': Math.round(med(cold)),
    'open Rules tab ms': med(rulesOpen),
    'DOM elements': dom,
    'search 1 key ms': +search.toFixed(1),
    'select-all + disable ms': +selAllMs.toFixed(0),
    'longest task ms': +longest.toFixed(0),
  });
}
console.table(rows);

// bulk import through the UI: 10 000 lines, measure main-thread blocking
{
  const t = await ctx.newPage();
  await t.goto(popupUrl);
  await t.waitForSelector('#power:not([disabled])');
  await seed(t, 0);
  await t.close();
  const out = [];
  for (const n of [10000, 50000]) {
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      localStorage.setItem('tab', 'proxy'); // cold-open the home tab regardless of the last visited one
      window.__long = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration);
      }).observe({ entryTypes: ['longtask'] });
    });
    await p.goto(popupUrl);
    await p.waitForSelector('#power:not([disabled])');
    await p.click('button[data-tab="rules"]');
    await p.click('button:has-text("Import")');
    const text = Array.from(
      { length: n },
      (_, i) => `i${i}.imp${i % 313}.org ${['PROXY', 'DIRECT', 'PAC'][i % 3]}`,
    ).join('\n');
    await p.evaluate((text) => {
      const a = document.querySelector('textarea[aria-label="Rules to import"]');
      a.value = text;
      a.dispatchEvent(new Event('input'));
    }, text);
    const s = Date.now();
    await p.click('button:has-text("Preview")');
    await p.waitForSelector('button:has-text("Import ")');
    const parseMs = Date.now() - s;
    const s2 = Date.now();
    await p.click(`button:has-text("Import ${n.toLocaleString()}")`);
    await p.waitForFunction(() => document.querySelector('.card h3')?.textContent !== 'Import rules');
    const saveMs = Date.now() - s2;
    const longest = await p.evaluate(() => window.__long);
    // time until the worker applied the new config
    const s3 = Date.now();
    await p.evaluate(
      async () =>
        new Promise((res) => {
          const t = setInterval(async () => {
            const r = await chrome.storage.local.get(['rev', 'state']);
            if (r.state?.appliedRev === r.rev) {
              clearInterval(t);
              res();
            }
          }, 20);
        }),
    );
    out.push({
      lines: n,
      'preview/parse ms': parseMs,
      'import+write ms': saveMs,
      'longest main-thread task ms': Math.round(longest),
      'worker applied after ms': Date.now() - s3,
    });
    if (n === 50000) {
      // Does real Chrome accept and correctly execute the large generated PAC?
      await p.click('button[data-tab="proxy"]');
      if (!(await p.isChecked('#power'))) await p.click('#power');
      await p.waitForFunction(() => document.querySelector('.badge')?.textContent === 'ACTIVE', null, {
        timeout: 15000,
      });
      const cfg = await p.evaluate(() => chrome.proxy.settings.get({ incognito: false }));
      const probe = await ctx.newPage();
      hits.length = 0;
      await probe.goto('http://i0.imp0.org/', { timeout: 15000 }).catch(() => {});
      const viaProxy = hits.some((u) => u.includes('i0.imp0.org'));
      hits.length = 0;
      await probe.goto('http://i1.imp1.org/', { timeout: 8000 }).catch(() => {});
      const direct = !hits.some((u) => u.includes('i1.imp1.org')); // i1 is DIRECT in the imported list
      ok(
        viaProxy && direct,
        `Chrome accepted and executed a ${(cfg.value.pacScript.data.length / 1024).toFixed(0)} KB PAC (50 000 imported rules): PROXY rule proxied, DIRECT rule direct`,
      );
      await probe.close();
      await p.click('#power');
    }
    await p.close();
  }
  console.log('\n== Bulk import via UI ==');
  console.table(out);
}

// ---- 3. Legacy popup for comparison ----------------------------------------------------------
await ctx.close();
if (process.env.LEGACY_DIR) {
  const l = await launch(process.env.LEGACY_DIR);
  const lurl = `chrome-extension://${l.id}/dist/src/popup/popup.html`;
  const legacyRows = [];
  for (const n of [0, 1000, 10000, 50000]) {
    const seedPage = await l.ctx.newPage();
    await seedPage.goto(lurl);
    await seedPage.evaluate(async (n) => {
      const ex = {};
      for (let i = 0; i < n; i++)
        ex[`${i % 5 ? '' : '*.'}host${i}.site${i % 997}.com`] = i % 3 ? 'yes' : 'no';
      await chrome.storage.local.set({
        domainExceptions: ex,
        proxies: [{ id: 1, url: 'socks5://127.0.0.1:1080' }],
        proxyActive: false,
      });
    }, n);
    await seedPage.close();
    const times = [];
    for (let i = 0; i < 5; i++) {
      const p = await l.ctx.newPage();
      await p.goto(lurl, { waitUntil: 'commit' });
      await p.waitForSelector('input[placeholder="*.example.com"]', { timeout: 60000 });
      times.push(await p.evaluate(() => performance.now()));
      if (i === 4) {
        await p.waitForTimeout(300);
        legacyRows.push({
          'exceptions in storage': n,
          'cold open to usable ms (median)': Math.round(med(times)),
          'DOM elements': await p.evaluate(() => document.getElementsByTagName('*').length),
        });
      }
      await p.close();
    }
  }
  console.log('\n== LEGACY popup (original extension, Exceptions tab usable) ==');
  console.table(legacyRows);
  await l.ctx.close();
}
proxy.close();
if (errors.length) console.log('\npage errors:', errors);
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nAll browser checks passed.');
process.exit(process.exitCode ?? 0);
