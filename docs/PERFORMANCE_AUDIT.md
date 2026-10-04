# Performance audit of `ilyachase/pac-proxy-manager-extension` (v1.1.2)

Method: full read of `src/background.js`, `src/utils/*`, all popup tabs, `manifest.json`,
`vite.config.js`; production build (`vite build`) for bundle sizes; the legacy
`ProxyManager.generateCombinedPacScript()` was executed in Node and the produced PAC was
loaded into a `vm` context to measure real `FindProxyForURL` cost
(`benchmarks/legacy-baseline.mjs`, run with `LEGACY_DIR=<clone>`).

## Measured baseline (legacy)

Rules = domain exceptions (every 5th is `*.wildcard`), one SOCKS5 proxy, no PAC scripts.
Lookup is per *request* and runs in the browser's PAC thread, so it directly adds latency to navigation.

| rules  | PAC size | generate | lookup miss | lookup exact hit |
|-------:|---------:|---------:|------------:|-----------------:|
| 100    | 4 KB     | 0.2 ms   | 5 µs        | 2 µs             |
| 1 000  | 30 KB    | 0.4 ms   | 25 µs       | 15 µs            |
| 10 000 | 302 KB   | 2.6 ms   | **1.57 ms** | 0.43 ms          |
| 50 000 | 1.55 MB  | 17 ms    | **12 ms**   | 3.9 ms           |

Bundle: `popup.js` **291 KB** (87 KB gzip), `popup.css` 22 KB, `background.js` 4.5 KB (+1.7 KB chunk).
574 modules transformed (React 18 + ReactDOM + Headless UI + Heroicons + react-hot-toast + Tailwind).

## Findings

Severity: **C** critical, **H** high, **M** medium, **L** low.

### 1. Lookup is O(N) per request — **C**
- Where: `proxyManager.js` `generateCombinedPacScript`, the `for (const domain in domainExceptions)` loop.
- Why: for every host that is not an exact key, the PAC iterates *all* rules and does `startsWith('*.')`
  + `endsWith`. Misses (the common case: most sites are not in the list) always pay the full scan.
  12 ms per request at 50k rules runs on the proxy-resolution path of every navigation/subresource.
- Fix: PAC lookup is O(labels in host): compile-time hash maps, walk the host's suffixes
  (`a.b.c.com` → `b.c.com` → `c.com` → `com`) with 1 object lookup each. Independent of N.

### 2. Rules stored as a single object in one `chrome.storage.local` key — **H**
- Where: `ExceptionsTab.jsx` `saveException`, `handleBulkImport`; `ProxyManager.updateProxySettings`.
- Why: adding one domain does `{...exceptions}` (O(N) copy), then structured-clones and writes the whole map,
  then `storage.onChanged` fires with old+new values of the whole map. The background re-reads the entire map
  and rebuilds the PAC. A single toggle costs O(N) in popup, storage and background.
- Fix: rules live in IndexedDB as individual records (one transaction for imports); the PAC is built from a
  single `getAll`, only when the *rules revision* changes; popup never ships the whole map through messages.

### 3. Every change rebuilds PAC and re-applies it, no hash check — **H**
- Where: `storage.onChanged` listener (`proxyManager.js` `init`), `pacScriptsUpdated`, `activateProxy`, `togglePacScript`.
- Why: `chrome.proxy.settings.set()` with a new `pac_script` makes Chrome re-parse the script and, in practice,
  drop proxy-resolution caches/pooled connections. Legacy calls it on any relevant key change, even when the
  generated PAC is byte-identical (e.g. `proxies` rewritten with the same value, `overridePacScript` flip with no
  proxies).
- Fix: PAC hash (FNV-1a 64 over the compiled text) + `appliedHash` persisted in `chrome.storage.session`/`local`;
  `set()` only when the hash differs.

### 4. Double/triple work per user action — **H**
- Where: `ProxiesTab.jsx`: `storage.local.set({proxies})` (→ `onChanged` → rebuild) **and** `sendMessage('activateProxy')`
  (→ `set` again → rebuild again). `PacScriptsTab.jsx`: IndexedDB write + `sendMessage('pacScriptsUpdated')`.
  `togglePacScript` in background does `getAll`, `find`, `put`, then `updateProxySettings` (another `getAll` + storage get).
- Why: 2–3 full rebuilds, 2–4 storage reads and several round-trips to the service worker per click.
- Fix: a single `commit` message; the worker owns the "apply" step; storage writes themselves never trigger a rebuild
  (worker is notified once, debounced, with a revision number).

### 5. Service worker does heavy work on every wake — **H**
- Where: `new ProxyManager()` at top-level; `init()` reads all PAC scripts from IndexedDB and, if any is enabled,
  calls `updateProxySettings()` (full rebuild + `proxy.settings.set`) on **every** worker start.
  MV3 workers are killed after ~30 s idle, so this repeats constantly.
- Fix: on wake the worker does nothing unless the event requires it. On `runtime.onStartup` it only verifies
  `appliedHash` against the stored config hash (O(1), no compile).

### 6. In-memory state in worker (`this.isProxyActive`) — **M**
- Where: `ProxyManager` constructor. Lost on worker restart; never read for decisions but indicates the design assumption.
- Fix: all state is in storage; worker is stateless.

### 7. Remote PAC fetched in the popup, stored as source and *inlined into generated JS* — **H** (perf + security)
- Where: `PacScriptsTab.jsx` `fetchPacScript`; `generateCombinedPacScript` injects `${script.content}` inside a function body.
- Why: fetch lives in popup (dies when popup closes → no refresh, no timeout/AbortController handling beyond the browser),
  no ETag/If-Modified-Since, no refresh schedule. Pasting a remote file inside `function userPacScriptN(){ ... }`
  breaks on scripts with top-level `function` redeclarations/`'use strict'`, and hides their helper names
  (`dnsResolve`, etc. work, but nested re-declaration of `FindProxyForURL` inside the wrapper is fragile).
  A syntax error in one remote script breaks the *whole* combined PAC and there is no validation.
- Fix: updater runs in the worker, triggered by `chrome.alarms`, with conditional requests, timeout, last-good
  content retained; sources are wrapped in an IIFE-per-source namespace and validated (`new Function` is
  **not** used — validation is a static structural check, and a failing source is excluded from the build, see ARCHITECTURE.md).

### 8. Hot path allocates / uses closures per call — **M**
- Where: generated `FindProxyForURL`: defines `checkDomainException` closure and a `const hasUserProxies` etc. **per call**,
  `JSON.stringify`'d rule object literal is re-parsed by V8 when PAC loads (a 1.5 MB object literal at 50k rules).
- Fix: static tables emitted once at script scope; `FindProxyForURL` has no inner function definitions.

### 9. Popup: 291 KB of JS parsed on every open — **H**
- Where: React + ReactDOM + Headless UI + Heroicons + react-hot-toast; all 4 tabs imported eagerly
  (`PopupApp.jsx`); Headless UI `TabPanels` mount every tab.
- Why: popup is a fresh page each open; parse+execute of ~300 KB (87 KB gz) is the floor on cold start,
  followed by IndexedDB open + `storage.local.get` + `runtime.sendMessage` (which may wake a dead service worker
  — 50–200 ms) before the skeleton is replaced.
- Fix: no framework in the first-paint path (see ARCHITECTURE.md); <15 KB gz target.

### 10. `chrome.i18n.getMessage` × ~30 per tab mount, put into React state — **L**
- Where: every tab `useEffect` → `setMessages`. Causes an extra render pass per tab. Fix: lookup lazily / static strings.

### 11. Exceptions UI rebuilds big strings in effects — **M**
- Where: `ExceptionsTab.jsx` effect on `[exceptions]`: `Object.keys(...).filter(...).join('\n')` twice and two `setState`
  after *every* exception change, then textarea re-renders with up to megabytes of text. There is no list view: the only
  way to see/edit rules is a raw textarea, so search/sort/bulk operations are not possible, and 10k lines in a controlled
  textarea re-render on every keystroke.
- Fix: virtualised list + search index; textarea only used for import input and is uncontrolled.

### 12. IndexedDB layer issues — **M**
- Where: `indexedDB.js`: `savePacScripts` calls `store.clear()` and `store.add()` without waiting on requests and
  returns `Promise.all` of IDBRequest objects (not promises) → ordering/error handling is accidental;
  `getPacScripts` is `getAll` of full script bodies (MBs) even when the UI only needs names/status; no revision/hash.
  PAC *content* and *metadata* are one record, so a toggle rewrites the full script text.
- Fix: metadata and body are separate records; toggles touch only metadata; batched single-transaction writes.

### 13. Permissions broader than needed — **M** (privacy)
- `host_permissions: http://*/*, https://*/*` + `activeTab`. Needed only to dodge CORS when fetching PAC URLs from the popup
  and to read the active tab URL. Fix: no host permissions; PAC fetch from the worker uses `optional_host_permissions`
  requested per-origin only when the user adds a PAC URL (the PAC server's origin only).

### 14. Failures are swallowed — **M**
- `catch (_error) { // Silently ignore }` in `updateProxySettings`; `getProxyStatus` can't surface "rejected by Chrome" /
  "controlled by other extension" reasons beyond a boolean. Fix: persisted `lastError` with typed codes, shown in popup.

### 15. Domain validation regex — **L**
- `domainValidation.js` uses a nested-quantifier regex executed per line; fine for hundreds of lines but it is re-run
  on every keystroke path and rejects valid inputs (IP literals, underscores, IDN/punycode, single-label hosts such as `localhost`).
- Fix: char-code scanner (no regex), IDN via `URL`-free punycode handling by `domainToASCII`-like normalisation only in import path.

## What is *not* the problem
- React render counts on small lists: popup interactions on ≤100 rules are cheap; the user-visible lag comes from
  (a) cold start of a 291 KB bundle + 3 async round trips, (b) the O(N) storage/PAC pipeline on every edit, and
  (c) O(N) PAC lookup that slows real page loads. Replacing React alone would fix (a) only partially.

## Resolution map

| # | Legacy problem | New design |
|---|---|---|
| 1 | O(N) lookup | suffix-walk over compiled hash maps, O(labels) |
| 2 | single big storage object | per-rule IndexedDB records, batched tx |
| 3 | no hash check | FNV-1a hash, apply only on change |
| 4 | duplicate rebuilds | single commit → one debounced rebuild |
| 5 | rebuild on wake | O(1) verification on wake |
| 6 | in-memory state | stateless worker |
| 7 | popup fetch / inline JS | worker updater + alarms + ETag + last-good |
| 8 | hot-path closures | static tables, zero-alloc hot path |
| 9 | 291 KB popup | vanilla TS popup, tiny |
| 10–12 | i18n/state/IDB inefficiencies | lazy, virtual list, split meta/body |
| 13 | broad host permissions | optional, per-origin |
