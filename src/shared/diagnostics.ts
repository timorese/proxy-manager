import type { PacSource, ProxyServer, RuntimeState, Settings } from '../types/index.ts';

export interface DiagnosticsInput {
  version: string;
  userAgent: string;
  settings: Settings;
  proxies: readonly ProxyServer[];
  pacs: readonly PacSource[];
  state: RuntimeState;
  rulesTotal: number;
  rulesEnabled: number;
  schema: number;
  now?: number;
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '(invalid url)';
  }
};

/**
 * Support bundle. Contains configuration *shape* and error state only:
 * no rule domains, no proxy hosts/credentials, no PAC URL paths or query strings, no PAC bodies, no browsing data.
 */
export function buildDiagnostics(i: DiagnosticsInput) {
  return {
    generatedAt: new Date(i.now ?? Date.now()).toISOString(),
    extension: { version: i.version, schema: i.schema },
    browser: i.userAgent,
    settings: i.settings,
    rules: { total: i.rulesTotal, enabled: i.rulesEnabled },
    proxies: i.proxies.map((p) => ({
      scheme: p.scheme,
      port: p.port,
      enabled: p.enabled,
      hostKind: /^[\d.]+$|^\[/.test(p.host) ? 'ip' : 'name',
    })),
    pacSources: i.pacs.map((p) => ({
      kind: p.kind,
      enabled: p.enabled,
      origin: p.kind === 'url' ? originOf(p.url) : null,
      refreshMinutes: p.refreshMinutes,
      bytes: p.fetch.bytes,
      hash: p.fetch.hash,
      lastAttemptAt: p.fetch.lastAttemptAt,
      lastSuccessAt: p.fetch.lastSuccessAt,
      hasEtag: p.fetch.etag !== '',
      error: p.fetch.error,
    })),
    applied: {
      kind: i.state.appliedKind,
      hash: i.state.appliedHash,
      at: i.state.appliedAt,
      pacBytes: i.state.pacBytes,
      rulesCompiled: i.state.rulesCompiled,
      revisionApplied: i.state.appliedRev !== '',
    },
    errors: i.state.errors,
  };
}
