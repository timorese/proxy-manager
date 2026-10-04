# Architecture

Goal: Chrome does the routing (`chrome.proxy` + PAC); the extension only *compiles configuration into a PAC and
applies it when, and only when, it changed*. Everything else is about not doing work.

```
                 ┌──────────────────────────── popup (vanilla TS, lives ~seconds) ─────────────────────────────┐
 user edit ────▶ │ view ─▶ repository ─▶ IndexedDB (rules, PAC meta+bodies) / chrome.storage.local (settings…)   │
                 │                                   └────────────▶ rev = new UUID  (1 tiny write)              │
                 └───────────────────────────────────────────────────────┬──────────────────────────────────────┘
                                                                          │ storage.onChanged (wakes the worker)
                 ┌───────────────────────── service worker (stateless, event driven) ──────────────────────────┐
                 │ debounce 250 ms ─▶ SyncEngine.sync()                                                         │
                 │   rev == state.appliedRev ? ── yes ─▶ stop (2 storage reads, nothing else)                   │
                 │   read config ─▶ normalize() ─▶ compile() ─▶ SHA-256 ─▶ hash == appliedHash ? ─ yes ─▶ stop  │
                 │                                                    └ no ─▶ chrome.proxy.settings.set(PAC)    │
                 │   write RuntimeState {appliedRev, appliedHash, errors…} to storage (survives worker death)   │
                 └──────────────────────────────────────────────────────────────────────────────────────────────┘
 Chrome ── per request ──▶ FindProxyForURL()  (O(labels in host), independent of rule count)
```

## Source layout

| dir | responsibility | depends on |
|---|---|---|
| `src/types` | data model (`Rule`, `ProxyServer`, `PacSource`, `Settings`, `RuntimeState`) | – |
| `src/domain-rules` | pattern normalisation, reference matcher, import/export text format | types |
| `src/pac` | `normalize()` → `compile()` (PacCompiler), static PAC-source validator | domain-rules, proxy/serialize |
| `src/proxy` | proxy validation/serialisation, `chrome.proxy` wrapper (`ProxyApi`, injectable) | – |
| `src/storage` | repository **interfaces** + IndexedDB / `chrome.storage` implementations, schema migrations | types |
| `src/background` | service worker: `SyncEngine`, remote-PAC `updater`, listeners | pac, proxy, storage |
| `src/popup` | UI | storage (via repositories), shared |
| `src/migration` | importer for the legacy extension's data; nothing in core imports it | types, proxy, domain-rules |
| `src/shared` | hashing, ids, message types, diagnostics | – |

The PAC compiler is a pure function of plain data: no `chrome.*`, no storage, no DOM. It runs unchanged in Node
(tests, benchmarks) and in the worker. The popup never compiles PAC and never calls `chrome.proxy`.

## Decision: Vanilla TypeScript, not Preact

| | React 18 stack (legacy) | Preact | Vanilla TS (chosen) |
|---|---|---|---|
| popup JS (min / gzip) | 291 KB / 87 KB | ~12 KB core + our code ≈ 25 KB / 10 KB (estimate, not built) | **16 KB / 6.5 KB eager** (+ 19.5 KB lazy tabs) |
| per-update cost | vdom diff of whole subtree | vdom diff | direct DOM writes to the nodes a view owns |

The UI is four small screens. The only non-trivial UI problem is the rules table, and there the framework does not
help: it needs a **recycled row pool** (fixed row height, `transform: translateY`) regardless of framework, so the
diffing layer would only be overhead. State is "what lives in `chrome.storage.local`" (a handful of small objects) plus
view-local arrays; views subscribe to *which key changed* (`settings` / `proxies` / `state`) and touch only their own DOM.
Result measured in Chromium: 45–58 ms cold open, 200 DOM elements at 50 000 rules. Preact numbers above are an estimate
(I did not build a Preact variant); the decision rests on "there is nothing for a vdom to do here", not on that estimate.

First paint: `popup.html` contains the static shell (header, tabs, switch, skeleton). `popup.css` is one render-blocking
7 KB file; `theme-boot.js` (150 B) sets the cached theme before paint; the module script then does **one**
`chrome.storage.local.get` and renders Home. IndexedDB is not opened until a tab needs it; Rules / PAC / Settings are
separate lazily imported chunks.

## Decision: where data lives

| data | store | why |
|---|---|---|
| settings, proxies, revision, runtime state | `chrome.storage.local` | tiny, read in one call, and `storage.onChanged` is the worker's wake-up signal |
| rules | IndexedDB, **256 buckets** of ~N/256 rules | see below |
| PAC source metadata and bodies | IndexedDB, separate stores | toggling a source rewrites metadata only, never the body; `list()` never loads MBs of script text |

Rejected: one `chrome.storage.local` key with all rules (legacy: every edit clones/writes/diffs the whole map, and
`onChanged` ships old+new copies to every listener). Rejected: one IndexedDB record per rule. Measured in real Chromium
(`benchmarks/idb-layout.mjs`, 50 000 rules):

| layout | writes (sync main-thread part / total) | read |
|---|---|---|
| 1 record per rule | 855 ms / 3 406 ms | 332 ms |
| **256 buckets of arrays (shipped)** | **57 ms / 72 ms** | **83 ms** |
| 256 buckets of text lines | 27 ms / 77 ms | 21 ms |

Per-record `put()` is dominated by per-request overhead, so "one transaction" alone does not make an import cheap; bucketing
does. Text buckets read faster but need a codec and the gain (~60 ms at 50k) did not justify it. A single-rule edit
rewrites one ~200-rule bucket. `bucketOf` (FNV-1a mod 256) is part of the on-disk format and is pinned by a test.

## Service worker contract

- All listeners registered synchronously at top level (`background/index.ts`): `onInstalled`, `onStartup`,
  `storage.onChanged` (only `rev`), `alarms.onAlarm`, `proxy.onProxyError`, `runtime.onMessage`.
- No `setInterval`, no polling, no DOM, no UI code. The only timer is the 250 ms debounce after a revision change.
- No state is trusted across restarts. `SyncEngine` is recreated lazily; `appliedRev`/`appliedHash`/errors are persisted.
  A test builds a second engine on the same storage and asserts it does not re-apply.
- Startup: `verify()` = one `proxy.settings.get`; re-applies only if Chrome says we lost control while enabled.
- `onProxyError` can fire per request, so the handler drops events within 5 s of the last one before touching storage
  and deduplicates identical messages. It is the one listener that can wake an idle worker repeatedly; it is the price of
  surfacing "Proxy error" to the user.
- Concurrent `sync()` calls coalesce (one in flight + one queued).

## When PAC is (not) rebuilt or applied

1. **Revision check** – every config write ends by writing a new random `rev`. If `rev === state.appliedRev` the worker
   returns after two storage reads.
2. **Hash check** – otherwise it compiles and compares SHA-256(PAC) with `appliedHash`. Same hash ⇒ `settings.set` is *not*
   called, only `appliedRev` is advanced. Verified in real Chrome: adding a rule that the compiler eliminates as redundant
   produces a new revision and zero `settings.set` calls.
3. Compile-time elimination makes (2) hit more often: duplicate rules, rules equal to what their parent wildcard or the
   default mode already yields, and `PROXY`/`PAC` actions with nothing behind them are dropped.
4. Toggle ON/OFF and explicit buttons skip the debounce: the popup sends `{t:'sync'}` and gets the result back.
   Ordinary edits send no message at all.
5. A failed `settings.set` does **not** advance `appliedRev`, so the next sync retries.

## PAC compiler

Input is normalised (`normalize()`), then `compile()` emits ES5 text:

```js
var D="DIRECT",P="SOCKS5 1.2.3.4:1080; DIRECT";          // chains precomputed at compile time
var E=Object.create(null),W=Object.create(null);          // exact table, wildcard table
function L(s,a,t){for(var i=0,l=s.split(" ");i<l.length;i++)t[l[i]]=a}
L("a.com b.com",1,E);L("c.org",2,E);L("x.net",1,W);       // domains packed per action; sorted => stable hash
function FindProxyForURL(u,h){
  if(h.charCodeAt(h.length-1)===46)h=h.slice(0,-1);
  var a=E[h];
  if(!a){var s=h,i;for(;;){a=W[s];if(a||(i=s.indexOf("."))<0)break;s=s.slice(i+1)}}
  if(a===1)return D;if(a===2)return P;
  if(h.indexOf(".")<0)return D;                            // bypassLocal, emitted only when relevant
  return P}
```

- **Priority** (also the reference `matcher.ts`, cross-checked against the PAC by a 20 000-lookup randomised test):
  exact host → most specific `*.parent` (a wildcard also matches its own base domain) → default mode.
  `example.com = PAC`, `*.google.com = PROXY`, `mail.google.com = DIRECT` behaves as in the task description (tested).
- **Hot path**: one property lookup for exact, then one per label for the suffix walk; no regex, no closures, no
  `Array.find/filter/map`, one `slice` per label (V8 sliced strings). Tables are built once at PAC load from packed
  strings (50k rules: 5.8 ms load).
- **Why not a trie**: measured (`npm run benchmark`, 10k rules): reversed-label trie 740–800 ns/lookup (needs `split`);
  object + suffix walk 50–540 ns; `Map` + suffix walk 80–270 ns. `Map` is ~2× faster than the object on misses
  but the absolute gain (~0.3 µs) is irrelevant next to per-request work and would drop ES5 compatibility; I kept
  null-prototype objects (also immune to host names like `constructor` / `__proto__`, tested).
- **Size**: ~16 bytes per *compiled* rule (domains are packed into space-separated strings, no quotes/colons). 50k generated
  rules (30k survive elimination) → 489 KB; 10k → 96 KB. The legacy encoding of 50k exceptions was 1.55 MB (10k: 302 KB).
  The two datasets are different generators, so treat this as order-of-magnitude, not an exact ratio.

### Combining PAC sources (security model)

Remote PAC text is **data**, never extension code: no `eval`, no `new Function`, no remote modules. The extension fetches
it (worker, `fetch`), statically sanity-checks it (`validatePacSource`: not HTML, not empty, brackets/strings/comments
balanced, defines `FindProxyForURL`), stores it, and embeds it as text into the PAC string handed to `chrome.proxy`.
That PAC is executed by Chrome's PAC interpreter, outside the extension context — the same trust model as pointing
Chrome at a PAC URL, and the reason MV3's "no remotely hosted code" rule does not apply to it.

Each source is wrapped in its own function scope (`function X0(){ <source>; return FindProxyForURL }`), so sources
cannot clobber each other's globals or ours (tested), and a source that throws at load or at call time is skipped.
Combination rule: for the `PAC` action (and for the default in `PAC` mode) sources are asked in the listed order and the
first answer that is not `DIRECT` wins; if none, `DIRECT`. A source that fails validation is excluded from the build and
reported (`PAC compilation failed`), it never breaks the rest. The validator is lexical, not a JS parser: a script that
passes can still contain a semantic error; Chrome then reports it via `onProxyError` (`Proxy error` in the popup) and
`mandatory:false` makes Chrome fall back to DIRECT instead of blocking traffic.

### Remote refresh

`chrome.alarms` (one alarm at the shortest configured interval, none when nothing refreshes) → `refreshSources()`.
`If-None-Match` / `If-Modified-Since` when a good copy exists, 15 s timeout via `AbortController`, 1 MB cap,
validation before replacing. 304, or 200 with an identical hash, only updates metadata (no revision bump, no rebuild).
Any failure only writes `error`/`lastAttemptAt`; the last good body keeps being used.

## Permissions

`proxy`, `storage`, `alarms`, `activeTab`. `activeTab` exists only so the popup can read the address of the tab it was opened on ("Current site" card); it grants nothing until the user opens the popup and shows no install warning. The card resolves the route by reading only the rule buckets that can match that host (`RuleRepository.getMany`), not the whole list. No `host_permissions`, no `tabs`, no `webRequest`. Remote PAC fetches use
`optional_host_permissions` requested for the PAC server's origin only, from the click that adds the source (if the user
declines, `fetch` still works when that server sends CORS headers). `minimum_chrome_version` is `120` (sub-minute alarms,
`color-mix()`); I only ran it on Chromium 141 (the one bundled in this sandbox), so lower versions are not verified.

## Known limits / non-goals

- UI languages: English and Russian (`src/popup/i18n.ts`: the English text is the key, `ru.ts` is loaded lazily, `tests/i18n.test.ts` guards completeness). The extension name/description in the manifest and error details produced by the worker (e.g. `Corp: HTTP 503`) stay English. Legacy shipped 13 locales.
- IPv6 literals are valid for proxy hosts but not for rules.
- Only `scope: 'regular'` (not incognito).
- No per-tab or URL-path rules: PAC receives the full URL, but domain rules are the requested scope.
- The ~1 MB PAC limit I recall for Chrome's PAC fetcher was **not verified**; a 284 KB generated PAC was accepted and
  executed correctly in Chromium (see `docs/PERFORMANCE.md`). The popup shows the applied PAC size in diagnostics.
