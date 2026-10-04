import { serializeProxy } from '../proxy/serialize.ts';
import type { AppError, ErrorCode, PacSource, ProxyServer, RuntimeState, Settings } from '../types/index.ts';
import { ago } from './format.ts';
import { t } from './i18n.ts';

export const ERROR_TITLE: Record<ErrorCode, string> = {
  pac_fetch_failed: 'PAC fetch failed',
  pac_compile_failed: 'PAC compilation failed',
  proxy_rejected: 'Proxy config rejected',
  invalid_proxy: 'Invalid proxy',
  invalid_rule: 'Invalid domain rule',
  controlled_by_other: 'Proxy controlled by another extension',
  proxy_runtime_error: 'Proxy error',
};

export interface StatusView {
  label: 'OFF' | 'ACTIVE' | 'PENDING' | 'ERROR';
  tone: 'ok' | 'warn' | 'err' | '';
  modeText: string;
  proxies: string[];
  rules: number;
  pac: string;
}

const FATAL: ReadonlySet<ErrorCode> = new Set(['proxy_rejected']);

export function describeStatus(
  settings: Settings,
  proxies: readonly ProxyServer[],
  state: RuntimeState,
  rev: string,
  pacs: readonly PacSource[] | undefined,
  now = Date.now(),
): StatusView {
  const rules = state.rulesTotal;
  const base = t(settings.mode === 'direct' ? 'Direct' : settings.mode === 'proxy' ? 'Proxy' : 'PAC');
  const enabledPacs = (pacs ?? []).filter((p) => p.enabled);
  const newest = enabledPacs.reduce((m, p) => Math.max(m, p.fetch.lastSuccessAt), 0);
  const pac =
    pacs === undefined
      ? '…'
      : enabledPacs.length === 0
        ? '—'
        : newest
          ? t('Updated {when}', { when: ago(newest, now) })
          : t('Not downloaded yet');

  let label: StatusView['label'] = 'ACTIVE';
  let tone: StatusView['tone'] = 'ok';
  if (!settings.enabled) {
    label = 'OFF';
    tone = '';
  } else if (state.errors.some((e) => FATAL.has(e.code))) {
    label = 'ERROR';
    tone = 'err';
  } else if (rev !== '' && rev !== state.appliedRev) {
    label = 'PENDING';
    tone = 'warn';
  } else if (state.errors.length > 0) {
    tone = 'warn';
  }
  return {
    label,
    tone,
    modeText: rules > 0 ? t('{mode} + rules', { mode: base }) : base,
    proxies: proxies.filter((p) => p.enabled).map(serializeProxy),
    rules,
    pac,
  };
}

/** Everything the user should see as a problem: sync/runtime errors plus failed PAC downloads. */
export function collectErrors(state: RuntimeState, pacs: readonly PacSource[] | undefined): AppError[] {
  const out = [...state.errors];
  for (const p of pacs ?? []) {
    if (p.enabled && p.kind === 'url' && p.fetch.error) {
      out.push({
        code: 'pac_fetch_failed',
        message: `${p.name}: ${p.fetch.error}`,
        at: p.fetch.lastAttemptAt,
      });
    }
  }
  return out;
}
