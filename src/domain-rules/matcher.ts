import type { Action, Rule } from '../types/index.ts';
import { isWildcard, patternHost } from './normalize.ts';

/**
 * Reference implementation of rule priority. The PAC compiler must behave identically
 * (verified by tests that run the generated PAC against this matcher).
 *
 *   1. exact rule for the host
 *   2. most specific wildcard: `*.a.b.com` matches `a.b.com` and every subdomain
 *   3. nothing -> caller falls back to PAC sources / mode default
 */
export interface RuleIndex {
  exact: Map<string, Action>;
  wild: Map<string, Action>;
}

export function buildIndex(rules: Iterable<Rule>): RuleIndex {
  const exact = new Map<string, Action>();
  const wild = new Map<string, Action>();
  for (const r of rules) {
    if (!r.enabled) continue;
    if (isWildcard(r.pattern)) wild.set(patternHost(r.pattern), r.action);
    else exact.set(r.pattern, r.action);
  }
  return { exact, wild };
}

/** Most specific wildcard covering `host` (host itself included). */
export function lookupWildcard(
  wild: Map<string, Action>,
  host: string,
): { base: string; action: Action } | undefined {
  let s = host;
  for (;;) {
    const a = wild.get(s);
    if (a !== undefined) return { base: s, action: a };
    const i = s.indexOf('.');
    if (i < 0) return undefined;
    s = s.slice(i + 1);
  }
}

export function lookup(index: RuleIndex, host: string): { action: Action; via: string } | undefined {
  if (host.endsWith('.')) host = host.slice(0, -1);
  const e = index.exact.get(host);
  if (e !== undefined) return { action: e, via: host };
  const w = lookupWildcard(index.wild, host);
  return w ? { action: w.action, via: `*.${w.base}` } : undefined;
}
