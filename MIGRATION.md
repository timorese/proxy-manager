# Migrating from PAC Proxy Manager 1.x (`ilyachase/pac-proxy-manager-extension`)

The importer lives in `src/migration/` and is the only code that knows the legacy data shapes. Nothing in the core
(compiler, repositories, worker) imports it.

## Two paths

**A. Installed over the legacy extension (same extension id).** On `onInstalled` the worker looks for the legacy
`chrome.storage.local` keys (`domainExceptions`, `proxies`, `proxyActive`) and the `PacProxyManagerDB` IndexedDB. If
found, it converts them once (flag `legacyMigrated`), in one batched write per store, and bumps the revision. Profiles
without legacy data are untouched (the probe aborts and removes the empty DB it just opened).

**B. Installed side by side (different id – the usual case for an unpacked/new listing).** Chrome does not let one
extension read another's storage, so export from the old popup and paste into **Settings → Import from PAC Proxy
Manager 1.x**:

1. Open the old extension's popup, right-click inside it → *Inspect*, open the *Console*.
2. Paste (verified against the real 1.1.2 build):

```js
(async()=>{const kv=await chrome.storage.local.get(["domainExceptions","proxies","proxyActive"]);const db=await new Promise((r,j)=>{const q=indexedDB.open("PacProxyManagerDB");q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});const pacScripts=await new Promise(r=>{const q=db.transaction("pacScripts").objectStore("pacScripts").getAll();q.onsuccess=()=>r(q.result)});const out=JSON.stringify({...kv,pacScripts});copy(out);return out.length+" chars copied"})()
```

3. Paste the clipboard into the new extension's import box and press **Import**.

The domain lists alone can also be pasted into **Rules → Import**: the parser accepts the old one-domain-per-line
format, and `yes` / `no` as aliases for `PROXY` / `DIRECT`.

## Mapping

| legacy | new |
|---|---|
| `domainExceptions[d] = 'yes'` | rule `d` → `PROXY` |
| `domainExceptions[d] = 'no'` | rule `d` → `DIRECT` |
| `domainExceptions[d] = 'pac'` | (legacy stored nothing for "PAC"; absence = default mode) |
| `*.example.com` | `*.example.com` (same semantics: base domain + all subdomains) |
| `proxies[].url` (`socks5://h:p`, `http://…`) | `ProxyServer` (scheme, host, port; default ports 80/443/1080) |
| `pacScripts[]` with `sourceType: 'url'` | PAC source, kind URL, last downloaded body kept, refresh = manual |
| `pacScripts[]` with `sourceType: 'plain'` | PAC source, kind inline |
| `proxyActive` or any enabled PAC script | master switch ON |
| no enabled PAC scripts | default mode **Direct** (legacy sent only `yes` domains through the proxy) |
| enabled PAC scripts | default mode **PAC** |

Invalid domains/proxies are skipped and reported in the import message.

## Behaviour that does not carry over exactly

- **"Override PAC proxies with mine"** (legacy `overridePacScript`): legacy replaced whatever proxy a PAC script
  returned with the user's proxy list. The new model has no equivalent; PAC sources answer with their own proxies. The
  importer warns when this setting was relevant. If you relied on it, set the default mode to **Proxy** and add
  `PAC` rules for the domains the script should decide.
- Legacy PAC scripts were pasted *inside* `function userPacScriptN(){…}`. They are now isolated per source in their own
  function scope, which is stricter; a script that depended on leaking globals into other scripts will not.
- Legacy refreshed nothing automatically. Imported URL sources start with refresh = manual; set an interval in the PAC tab.
- Legacy UI language packs (13 locales) are not carried over; the new UI is English and Russian.

Tests: `tests/migration.test.ts` (mapping, junk handling, and an end-to-end legacy → PAC → routing check).
