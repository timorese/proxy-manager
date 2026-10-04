import { normalizePattern } from '../domain-rules/normalize.ts';
import { parseProxy } from '../proxy/serialize.ts';
import { newId } from '../shared/ids.ts';
import {
  DEFAULT_SETTINGS,
  type PacSource,
  type ProxyServer,
  type Rule,
  type Settings,
} from '../types/index.ts';

/**
 * Pure mapping from the data model of `ilyachase/pac-proxy-manager-extension` v1.x to ours.
 * Nothing in the core imports this module; the legacy shapes stop here.
 */
export interface LegacyData {
  /** chrome.storage.local.domainExceptions: `{ "*.example.com": "yes" | "no" }` */
  domainExceptions?: Record<string, string>;
  /** chrome.storage.local.proxies: `[{ id, url: "socks5://1.2.3.4:1080" }]` */
  proxies?: { id?: unknown; url?: unknown }[];
  proxyActive?: boolean;
  /** chrome.storage.local.overridePacScript: legacy default is ON (anything but `false`). */
  overridePacScript?: boolean;
  /** IndexedDB PacProxyManagerDB.pacScripts */
  pacScripts?: {
    id?: unknown;
    name?: unknown;
    content?: unknown;
    enabled?: unknown;
    sourceType?: unknown;
    sourceUrl?: unknown;
  }[];
}

export interface MigrationPlan {
  settings: Partial<Settings>;
  proxies: ProxyServer[];
  rules: Rule[];
  pacs: { source: PacSource; body: string }[];
  warnings: string[];
}

export function mapLegacy(data: LegacyData, now = Date.now()): MigrationPlan {
  const warnings: string[] = [];
  const rules: Rule[] = [];
  for (const [domain, option] of Object.entries(data.domainExceptions ?? {})) {
    const n = normalizePattern(domain);
    if (!n.ok) {
      warnings.push(`skipped rule "${domain}": ${n.error}`);
      continue;
    }
    // yes = "use the proxy for this domain", no = "never proxy this domain"
    if (option === 'yes' || option === 'no')
      rules.push({ pattern: n.pattern, action: option === 'yes' ? 'proxy' : 'direct', enabled: true });
  }

  const proxies: ProxyServer[] = [];
  for (const p of data.proxies ?? []) {
    if (typeof p.url !== 'string') continue;
    const parsed = parseProxy(p.url);
    if (!parsed.ok) {
      warnings.push(`skipped proxy "${p.url}": ${parsed.error}`);
      continue;
    }
    proxies.push({ id: newId(), scheme: parsed.scheme, host: parsed.host, port: parsed.port, enabled: true });
  }

  const pacs: MigrationPlan['pacs'] = [];
  for (const s of data.pacScripts ?? []) {
    if (typeof s.content !== 'string' || s.content.trim() === '') continue;
    const isUrl = s.sourceType === 'url' && typeof s.sourceUrl === 'string' && s.sourceUrl !== '';
    pacs.push({
      source: {
        id: newId(),
        name: typeof s.name === 'string' && s.name ? s.name : 'Imported PAC',
        kind: isUrl ? 'url' : 'inline',
        url: isUrl ? (s.sourceUrl as string) : '',
        enabled: s.enabled !== false,
        refreshMinutes: 0,
        fetch: {
          lastAttemptAt: now,
          lastSuccessAt: now,
          etag: '',
          lastModified: '',
          hash: '',
          bytes: s.content.length,
          error: '',
        },
      },
      body: s.content,
    });
  }

  // Legacy semantics: with no PAC scripts only `yes` domains were proxied (everything else DIRECT);
  // with PAC scripts, the PAC decided for unlisted hosts.
  const hasPac = pacs.some((p) => p.source.enabled);
  const settings: Partial<Settings> = {
    ...DEFAULT_SETTINGS,
    enabled: Boolean(data.proxyActive) || hasPac,
    mode: hasPac ? 'pac' : 'direct',
    // legacy "override PAC": the user's proxies replace whatever proxy a PAC script answers with
    overridePac:
      hasPac && proxies.length > 0 && data.overridePacScript !== false && Boolean(data.proxyActive),
  };
  return { settings, proxies, rules, pacs, warnings };
}
