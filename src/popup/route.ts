import { buildIndex, lookup } from '../domain-rules/matcher.ts';
import type { Action, Rule, Settings } from '../types/index.ts';

/** Every stored pattern that could decide `host`: the exact host and `*.s` for the host and each parent suffix. */
export function candidatePatterns(host: string): string[] {
  const out = [host];
  let s = host;
  for (;;) {
    out.push(`*.${s}`);
    const i = s.indexOf('.');
    if (i < 0) return out;
    s = s.slice(i + 1);
  }
}

/** Host name of an http(s) URL, or '' for anything else (chrome://, extension pages, new tab, file:). */
export function hostOfUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:'
      ? u.hostname.toLowerCase().replace(/\.$/, '')
      : '';
  } catch {
    return '';
  }
}

/** Pattern the "add to list" button creates: `*.example.com` (www. stripped, like the legacy extension) or the exact host. */
export function patternForSite(host: string, subdomains: boolean): string {
  const base = subdomains && host.startsWith('www.') ? host.slice(4) : host;
  return subdomains ? `*.${base}` : host;
}

export interface Route {
  action: Action;
  kind: 'off' | 'rule' | 'local' | 'default';
  /** The matching pattern when kind === 'rule'. */
  via?: string;
  /** Why the shown action differs from what was configured. */
  note?: string;
}

/**
 * Explains how the compiled PAC treats `host` (same priority as the compiler / matcher):
 * rule (exact, then most specific wildcard) → plain-hostname bypass → default mode.
 * `rules` are the stored rules returned by RuleRepository.getMany(candidatePatterns(host)).
 */
export function explainRoute(
  host: string,
  settings: Pick<Settings, 'enabled' | 'mode' | 'bypassLocal'>,
  have: { proxies: boolean; pacs: boolean },
  rules: readonly Rule[],
): Route {
  if (!settings.enabled) return { action: 'direct', kind: 'off', note: 'Proxy is OFF' };
  const degrade = (a: Action): { action: Action; note?: string } =>
    a === 'proxy' && !have.proxies
      ? { action: 'direct', note: 'no proxy enabled' }
      : a === 'pac' && !have.pacs
        ? { action: 'direct', note: 'no PAC source enabled' }
        : { action: a };
  const hit = lookup(buildIndex(rules), host);
  if (hit) return { ...degrade(hit.action), kind: 'rule', via: hit.via };
  if (settings.bypassLocal && !host.includes('.'))
    return { action: 'direct', kind: 'local', note: 'plain host name' };
  return { ...degrade(settings.mode), kind: 'default' };
}

export const describeVia = (r: Route, mode: string): string =>
  r.kind === 'rule' ? `rule ${r.via}` : r.kind === 'default' ? `default (${mode} mode)` : (r.note ?? '');
