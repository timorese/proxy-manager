# Performance

All numbers: this sandbox (Linux container, Node 22.22, Chromium 141.0.7390.37 headless from `/opt/pw-browsers`),
single run set; use them for ratios, not absolutes. Reproduce with the commands in each section.

## 1. Per-request cost (what the user feels while browsing)

`npm run benchmark` runs the generated PAC in a Node `vm` (loop inside the context, so VM boundary crossings are excluded).
Legacy numbers from `LEGACY_DIR=<clone> npm run benchmark:legacy`.

| rules | legacy miss | legacy exact hit | **new miss** | **new exact** | **new wildcard** |
|------:|------------:|-----------------:|-------------:|--------------:|-----------------:|
| 100   | 5 µs        | 2 µs             | 1.3 µs       | 1.6 µs        | 1.5 µs           |
| 1 000 | 25 µs       | 15 µs            | 1.4 µs       | 0.9 µs        | 1.4 µs           |
| 10 000| 1 567 µs    | 426 µs           | 1.3 µs       | 1.1 µs        | 1.6 µs           |
| 50 000| **11 998 µs** | 3 922 µs       | 1.3 µs       | 1.0 µs        | 1.7 µs           |

Lookup is flat: ×0.9 from 100 → 50 000 rules (legacy: ×2 353). (The ~1 µs floor is call overhead inside `vm`.)

## 2. Compile pipeline (worker, only when the config actually changed)

| rules  | normalize | normalize + compile | hash (SHA-256) | PAC size | gzip | PAC load | rules kept* |
|-------:|----------:|--------------------:|---------------:|---------:|-----:|---------:|------------:|
| 100    | 0.3 ms    | 0.1 ms              | 0.3 ms         | 1.5 KB   | 0.8 KB | 0.5 ms | 54          |
| 1 000  | 0.3 ms    | 1.5 ms              | 0.3 ms         | 9.9 KB   | 3.0 KB | 0.6 ms | 613         |
| 10 000 | 3.0 ms    | 15 ms               | 0.7 ms         | 95.8 KB  | 24 KB  | 2.0 ms | 6 022       |
| 50 000 | 20 ms     | 78 ms               | 2.8 ms         | 489 KB   | 114 KB | 5.8 ms | 29 892      |

\* after dedupe + redundancy elimination. Legacy generation at 50k: 17 ms but a 1.55 MB script and 12 ms/request.
Import text parsing (Node): 0.4 / 1.8 / 14 / 80 ms for 100 / 1k / 10k / 50k lines.
Rule search (substring scan of normalised patterns): 0.01 / 0.08 / 0.34 / 2.1 ms. Sort by domain: 0.02 / 0.4 / 4 / 28 ms.
→ Neither a Web Worker for import/normalisation nor a prebuilt search index is justified: 50k lines parse in 80 ms
(browser: 38–111 ms incl. UI), a keystroke filter costs ≈ 2 ms, and a 250 ms debounce is not needed on search
(filter is coalesced per animation frame instead).

## 3. Real Chromium (`npm run build && npm run benchmark:browser`)

End-to-end checks, all PASS: MV3 manifest accepted; permissions exactly `proxy/storage/alarms`; a PROXY rule reaches a local
proxy while an unlisted host stays DIRECT; a redundant rule produces a new revision and **no** `settings.set`; a real change
produces exactly one; an edit made right after `ServiceWorker.stopAllWorkers` is applied (storage event wakes the worker;
note: I could not independently prove that Chrome had terminated the worker in this headless run — the restart
property is asserted by the unit test that builds a fresh `SyncEngine` over the same storage); OFF releases control;
remote PAC source via the UI: downloaded once by the worker, one `chrome.alarms` alarm at the configured period, manual Update sends `If-None-Match` and the 304 causes no rebuild, mode PAC routes through the third-party script, and after the PAC server goes offline the error is shown (PAC tab + Home) while the last good script keeps routing (the test PAC server sends CORS headers because headless Chromium cannot answer the optional host-permission prompt, so that prompt path itself is untested);
Chrome accepted and correctly executed a 284 KB PAC produced from 50 000 imported rules.

Popup (median of 5 cold opens, rules pre-seeded in IndexedDB):

| rules | cold open → usable | open Rules tab | DOM elements | 1-key search | select all + disable | longest main-thread task |
|------:|-------------------:|---------------:|-------------:|-------------:|---------------------:|-------------------------:|
| 0     | 45 ms              | 80 ms          | 60           | ≤ 27 ms*     | –                    | –                        |
| 1 000 | 49 ms              | 99 ms          | 200          | 10 ms        | 19 ms                | 0                        |
| 10 000| 52 ms              | 100 ms         | 200          | ≤ 24 ms*     | 19 ms                | 0                        |
| 50 000| 46 ms              | 187 ms         | **200**      | 9 ms         | 37 ms                | 71 ms                    |

\* includes `requestAnimationFrame` wait and first-run JIT; varies 4–27 ms between runs, no trend with N.
Legacy popup on the same machine: **89 ms (empty) → 111 ms (10k) → 271 ms (50k exceptions)** to a usable Exceptions tab.
"Cold open" for the new popup does not include loading rules (deferred to the Rules tab, which is the 187 ms @ 50k).

Bulk import through the UI (paste → Preview → Import → worker applied):

| lines  | parse + preview | write (1 transaction) | longest main-thread task | until the worker applied the new PAC |
|-------:|----------------:|----------------------:|-------------------------:|-------------------------------------:|
| 10 000 | 71 ms           | 108 ms                | < 50 ms (no long task)   | 263 ms                               |
| 50 000 | 111 ms          | 200 ms                | 69 ms                    | 323 ms                               |

### What the browser measurements changed (found by measuring, not by guessing)

1. First browser run, per-rule IndexedDB records: 50k import blocked the main thread **2.7 s** (≈55 µs per `put`),
   select-all + disable 1.0 s, Rules tab 448 ms. Node + fake-indexeddb hid this completely.
   → `benchmarks/idb-layout.mjs` compared three layouts in real Chrome; rules now live in 256 buckets
   (write 3.4 s → 72 ms, read 332 → 83 ms at 50k). See ARCHITECTURE.md.
2. Pasting 10–50k lines into a `<textarea>` cost hundreds of ms of layout on its own → large pastes are moved out of
   the textarea into memory.
3. Virtualisation: confirmed necessary and sufficient — DOM stays at ~200 elements for any N (a flat table would be
   4N+ nodes: 200 000 at 50k).

## 4. Bundle (`npm run build`)

| | new | legacy (React 18 + Headless UI + Heroicons + toast + Tailwind) |
|---|---:|---:|
| popup JS, eager (first paint) | 16.0 KB (6.5 KB gz) | 291 KB (87.5 KB gz) |
| popup JS, lazy tabs | 19.5 KB (8.1 KB gz) | – (all eager) |
| background JS | 21.3 KB (8.9 KB gz) | 6.2 KB (2.2 KB gz) |
| CSS | 7.4 KB (2.2 KB gz) | 22.4 KB (4.9 KB gz) |
| total JS | 50.8 KB (21.2 KB gz) | 297 KB |
| runtime dependencies | **0** | 7 |

The worker is larger than legacy's because it now contains the compiler, validator, updater, and migration code.
Dependency contribution: nothing third-party is bundled; `devDependencies` are build/test only.

## 5. Regression guards

- `tests/perf.test.ts` (runs in `npm test`): exact PAC byte ceilings for 100/1k/10k/50k generated rules (≈ +15 % of today),
  generous compile-time ceilings, and "lookup µs ≤ 25 at every size" (catches any return to O(N) lookup).
- `npm run benchmark` exits non-zero when `benchmarks/thresholds.json` is exceeded (compile, import, hash, search,
  lookup, lookup scaling ratio ≤ 12× from 100 → 50k).
- `npm run benchmark:browser` is the real-Chrome end-to-end + popup benchmark (needs Playwright and a Chromium).

## 6. Things deliberately not optimised (no benchmark justified them)

- No Web Worker for import, no search index, no memoisation layer, no caching of compiled PAC: compile is 78 ms at 50k and
  runs only on an actual change; the revision + hash checks already skip all unchanged work.
- No trie / Map in the PAC (see ARCHITECTURE.md).
- Not measured: battery/RAM of the idle worker beyond "it does nothing between events"; Chrome's behaviour with PACs near
  1 MB; real-network remote-PAC refresh (covered by mocked-`fetch` unit tests only).
