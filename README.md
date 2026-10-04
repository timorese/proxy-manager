# PAC Proxy Manager (next generation)

A Manifest V3 Chrome/Chromium extension for managing proxies, PAC scripts and per-domain rules. Chrome does the routing
(`chrome.proxy` + a compiled PAC); the extension only compiles configuration into PAC and applies it when it actually changed.

Functional reference: [ilyachase/pac-proxy-manager-extension](https://github.com/ilyachase/pac-proxy-manager-extension).
This is a from-scratch rewrite, not a fork — see [`docs/PERFORMANCE_AUDIT.md`](docs/PERFORMANCE_AUDIT.md) for why.

## Features

- Default mode for unlisted sites: **Direct** (rules opt sites into the proxy), **Proxy**, or **PAC**; master ON/OFF.
- Proxies: HTTP, HTTPS, SOCKS4, SOCKS5; several in failover order → `SOCKS5 a:1080; SOCKS5 b:1080; DIRECT`.
- Rules: `example.com` (exact), `*.example.com` (base + all subdomains) → `DIRECT` / `PROXY` / `PAC`.
  Priority: exact → most specific wildcard → default mode. Search, sort, bulk enable/disable/delete/set-action, "test a host",
  text import/export (`example.com`, `example.com DIRECT`, `#off …` for disabled), 50 000 rules without lag.
- PAC sources: remote URL (conditional requests, timeout, periodic refresh via `chrome.alarms`, last-good fallback) or
  inline script; several, each enable/disable-able, combined safely (see ARCHITECTURE.md).
- Errors shown in the popup: PAC fetch failed · PAC compilation failed · Proxy config rejected · Invalid proxy ·
  Invalid domain rule · controlled by another extension. **Export diagnostics** contains no domains, hosts or URL paths.
- Light/dark theme, import from 1.x ([MIGRATION.md](MIGRATION.md)).
- Current site card on the Proxy tab: shows which route applies to the open site (DIRECT / PROXY / PAC and the rule or default that decided it) and adds it to the list in one click (`*.site`, with or without subdomains).
- Privacy: permissions are `proxy`, `storage`, `alarms`, `activeTab` (the open tab's address is read only when you open the popup; no history); no `webRequest`, no host permissions (optional per-origin
  permission for the PAC server you add), no analytics, no `eval`, no remote code, zero runtime dependencies.

## Develop

```bash
npm install
npm run dev          # vite build --watch (development mode, sourcemaps)
npm run build        # production build into dist/ + bundle report
npm test             # vitest: unit + integration (config → PAC → chrome.proxy), perf regression guards
npm run typecheck    # tsc --noEmit (strict)
npm run lint         # biome
npm run benchmark    # pipeline benchmarks + regression thresholds (Node)
npm run benchmark:browser   # real-Chromium e2e + popup benchmark (needs Playwright + Chromium)
LEGACY_DIR=/path/to/legacy-clone npm run benchmark:legacy   # baseline of the original PAC generator
```

Load `dist/` via `chrome://extensions` → Developer mode → *Load unpacked*.

## Docs

- [docs/PERFORMANCE_AUDIT.md](docs/PERFORMANCE_AUDIT.md) – what was slow in 1.x, measured, and how it is fixed
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – layers, framework decision, storage, worker contract, PAC compiler, security model
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) – all measurements (Node + real Chromium), bundle sizes, regression guards
- [MIGRATION.md](MIGRATION.md) – importing 1.x data

## Headline numbers (this sandbox, see PERFORMANCE.md)

| | legacy 1.1.2 | this |
|---|---:|---:|
| PAC lookup per request @ 50k rules | 12 ms | 1.3 µs |
| PAC size @ 50k rules | 1.55 MB | ~0.5 MB |
| popup JS (eager) | 291 KB | 16 KB |
| popup cold open (50k rules stored) | 271 ms | 46 ms |
| 50k-line import, longest main-thread task | not measured | 69 ms |

## Install from a release

1. Download `pac-proxy-manager-<version>.zip` from the GitHub *Releases* page and unzip it into a folder you will keep.
2. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick that folder.

Maintainers: publish a release in the GitHub UI and `.github/workflows/release.yml` lints, tests, builds and attaches the zip. For an existing release: Actions → Release → Run workflow → enter its tag.
