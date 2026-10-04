import { lookupWildcard } from '../domain-rules/matcher.ts';
import { isWildcard, normalizePattern, patternHost } from '../domain-rules/normalize.ts';
import { serializeChain, validateProxy } from '../proxy/serialize.ts';
import type { Action, Mode, ProxyServer, Rule } from '../types/index.ts';

/** Everything the compiler needs. Plain data: the compiler knows nothing about storage, UI or chrome.*. */
export interface PacConfig {
  mode: Mode;
  failoverDirect: boolean;
  bypassLocal: boolean;
  /** Enabled proxies only, in failover order. */
  proxies: readonly ProxyServer[];
  /** Enabled rules only. */
  rules: readonly Pick<Rule, 'pattern' | 'action'>[];
  /** Enabled, already validated PAC source texts, in priority order. */
  sources: readonly { id: string; text: string }[];
}

export interface NormalizedConfig {
  mode: Mode;
  chain: string; // '' when there are no proxies
  bypassLocal: boolean;
  sources: readonly { id: string; text: string }[];
  /** Effective rules after dedupe + redundancy elimination, keyed by normalised pattern. */
  exact: Map<string, Action>;
  wild: Map<string, Action>;
  stats: { rulesIn: number; invalid: number; duplicates: number; redundant: number };
  warnings: string[];
}

export interface CompileResult {
  /** `direct`: nothing to route, caller should not install a PAC at all. */
  kind: 'direct' | 'pac';
  text: string;
  rulesCompiled: number;
  stats: NormalizedConfig['stats'] & { bytes: number; exactRules: number; wildcardRules: number };
  warnings: string[];
}

const ACTION_CODE: Record<Action, number> = { direct: 1, proxy: 2, pac: 3 };

/**
 * normalize(): validate, lowercase, dedupe, map actions that cannot take effect to DIRECT,
 * and drop rules that resolve to the same result without being listed.
 */
export function normalize(cfg: PacConfig): NormalizedConfig {
  const warnings: string[] = [];
  const proxies = cfg.proxies.filter((p) => !validateProxy(p));
  if (proxies.length !== cfg.proxies.length) warnings.push('invalid proxies were ignored');
  const chain = proxies.length > 0 ? serializeChain(proxies, cfg.failoverDirect) : '';
  const hasProxy = chain !== '';
  const hasPac = cfg.sources.length > 0;

  // An action that has nothing behind it degrades to DIRECT (never to a black hole).
  const effective = (a: Action): Action =>
    a === 'proxy' && !hasProxy ? 'direct' : a === 'pac' && !hasPac ? 'direct' : a;
  const fallback = effective(cfg.mode);
  if (cfg.mode === 'proxy' && !hasProxy) warnings.push('mode is PROXY but no proxy is enabled');
  if (cfg.mode === 'pac' && !hasPac) warnings.push('mode is PAC but no PAC source is enabled');

  const exactAll = new Map<string, Action>();
  const wildAll = new Map<string, Action>();
  let invalid = 0;
  let duplicates = 0;
  for (const r of cfg.rules) {
    const n = normalizePattern(r.pattern);
    if (!n.ok) {
      invalid++;
      continue;
    }
    const action = effective(r.action);
    const target = isWildcard(n.pattern) ? wildAll : exactAll;
    const key = isWildcard(n.pattern) ? patternHost(n.pattern) : n.pattern;
    if (target.has(key)) duplicates++; // later rule wins: deterministic for a given input order
    target.set(key, action);
  }

  const bypass = (host: string): boolean => cfg.bypassLocal && host.indexOf('.') < 0;
  const exact = new Map<string, Action>();
  const wild = new Map<string, Action>();
  let redundant = 0;
  // Compare against the *original* wildcard set: a dropped rule resolves exactly like its ancestor,
  // so chains of redundant rules collapse correctly.
  for (const [base, action] of wildAll) {
    const dot = base.indexOf('.');
    const inherited = dot < 0 ? undefined : lookupWildcard(wildAll, base.slice(dot + 1))?.action;
    const implied = inherited ?? (bypass(base) ? undefined : fallback);
    if (implied === action) redundant++;
    else wild.set(base, action);
  }
  for (const [host, action] of exactAll) {
    const inherited = lookupWildcard(wildAll, host)?.action;
    const implied = inherited ?? (bypass(host) ? undefined : fallback);
    if (implied === action) redundant++;
    else exact.set(host, action);
  }

  return {
    mode: cfg.mode,
    chain,
    bypassLocal: cfg.bypassLocal,
    sources: cfg.sources,
    exact,
    wild,
    stats: { rulesIn: cfg.rules.length, invalid, duplicates, redundant },
    warnings,
  };
}

function pack(map: Map<string, Action>): Map<number, string[]> {
  const byCode = new Map<number, string[]>();
  for (const [host, action] of map) {
    const code = ACTION_CODE[action];
    let list = byCode.get(code);
    if (!list) byCode.set(code, (list = []));
    list.push(host);
  }
  for (const list of byCode.values()) list.sort(); // stable output => stable hash
  return byCode;
}

/** compile(): NormalizedConfig -> PAC text. Pure and deterministic. */
export function compile(n: NormalizedConfig): CompileResult {
  const fallback: Action =
    n.mode === 'proxy' && n.chain ? 'proxy' : n.mode === 'pac' && n.sources.length ? 'pac' : 'direct';
  const exact = pack(n.exact);
  const wild = pack(n.wild);
  const stats = { ...n.stats, exactRules: n.exact.size, wildcardRules: n.wild.size, bytes: 0 };
  const rulesCompiled = n.exact.size + n.wild.size;

  if (rulesCompiled === 0 && fallback === 'direct') {
    return { kind: 'direct', text: '', rulesCompiled, stats, warnings: n.warnings };
  }

  const usesProxy = fallback === 'proxy' || [...exact.keys(), ...wild.keys()].includes(ACTION_CODE.proxy);
  const usesPac = fallback === 'pac' || [...exact.keys(), ...wild.keys()].includes(ACTION_CODE.pac);

  let out = 'var D="DIRECT"';
  if (usesProxy) out += `,P=${JSON.stringify(n.chain)}`;
  out += ';';

  if (usesPac) {
    out += 'var S=[];';
    n.sources.forEach((s, i) => {
      // Each source lives in its own function scope: its globals / FindProxyForURL cannot clash with ours or with each other.
      out += `function X${i}(){${s.text}\n;return typeof FindProxyForURL=="function"?FindProxyForURL:null}`;
      out += `try{var f${i}=X${i}();f${i}&&S.push(f${i})}catch(e){}`;
    });
    out +=
      'function Q(u,h){for(var i=0,r;i<S.length;i++){try{r=S[i](u,h)}catch(e){continue}if(r&&r!==D)return r}return D}';
  }

  const hasExact = exact.size > 0;
  const hasWild = wild.size > 0;
  if (hasExact || hasWild) {
    out += 'function L(s,a,t){for(var i=0,l=s.split(" ");i<l.length;i++)t[l[i]]=a}';
    if (hasExact) out += 'var E=Object.create(null);';
    if (hasWild) out += 'var W=Object.create(null);';
    for (const [table, packed] of [
      ['E', exact],
      ['W', wild],
    ] as const) {
      for (const code of [1, 2, 3]) {
        const list = packed.get(code);
        if (list) out += `L("${list.join(' ')}",${code},${table});`;
      }
    }
  }

  const ret = (code: number, tail = ''): string =>
    (code === 1 ? 'return D' : code === 2 ? 'return P' : 'return Q(u,h)') + tail;
  out += 'function FindProxyForURL(u,h){';
  if (hasExact || hasWild) {
    out += 'if(h.charCodeAt(h.length-1)===46)h=h.slice(0,-1);var a';
    if (hasExact && hasWild)
      out += '=E[h];if(!a){var s=h,i;for(;;){a=W[s];if(a||(i=s.indexOf("."))<0)break;s=s.slice(i+1)}}';
    else if (hasExact) out += '=E[h];';
    else out += ';{var s=h,i;for(;;){a=W[s];if(a||(i=s.indexOf("."))<0)break;s=s.slice(i+1)}}';
    const present = new Set([...exact.keys(), ...wild.keys()]);
    for (const code of [1, 2, 3]) if (present.has(code)) out += `if(a===${code})${ret(code)};`;
  }
  if (fallback !== 'direct' && n.bypassLocal) out += 'if(h.indexOf(".")<0)return D;';
  out += `${ret(ACTION_CODE[fallback])}}`;

  stats.bytes = out.length;
  return { kind: 'pac', text: out, rulesCompiled, stats, warnings: n.warnings };
}

export const compilePac = (cfg: PacConfig): CompileResult => compile(normalize(cfg));
