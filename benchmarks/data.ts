import type { Action, Rule } from '../src/types/index.ts';

/** Deterministic pseudo-random generator so every run measures the same data. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const TLDS = ['com', 'org', 'net', 'io', 'ru', 'de', 'co.uk', 'app'];
const WORDS = ['mail', 'www', 'cdn', 'api', 'static', 'img', 'login', 'm', 'edge', 'a', 'b', 'x1', 'shop'];

/**
 * Realistic-ish list: 80% exact hosts (mostly subdomains of a smaller set of registrable domains),
 * 20% `*.domain` wildcards, actions 50/40/10 proxy/direct/pac.
 */
export function makeRules(n: number, seed = 1): Rule[] {
  const r = rng(seed);
  const registrable = Math.max(10, Math.floor(n / 4));
  const out = new Map<string, Rule>();
  let guard = 0;
  while (out.size < n && guard++ < n * 20) {
    const base = `site${Math.floor(r() * registrable)}.${TLDS[Math.floor(r() * TLDS.length)]}`;
    const wild = r() < 0.2;
    const host =
      wild || r() < 0.2 ? base : `${WORDS[Math.floor(r() * WORDS.length)]}${Math.floor(r() * 30)}.${base}`;
    const pattern = wild ? `*.${host}` : host;
    const x = r();
    const action: Action = x < 0.5 ? 'proxy' : x < 0.9 ? 'direct' : 'pac';
    out.set(pattern, { pattern, action, enabled: true });
  }
  return [...out.values()];
}

export interface LookupSets {
  exact: string[];
  wildSub: string[];
  miss: string[];
}

export function makeLookups(rules: readonly Rule[], count = 2000, seed = 7): LookupSets {
  const r = rng(seed);
  const exacts = rules.filter((x) => x.pattern.charCodeAt(0) !== 42).map((x) => x.pattern);
  const wilds = rules.filter((x) => x.pattern.charCodeAt(0) === 42).map((x) => x.pattern.slice(2));
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  const exact: string[] = [];
  const wildSub: string[] = [];
  const miss: string[] = [];
  for (let i = 0; i < count; i++) {
    exact.push(exacts.length ? pick(exacts) : 'none.com');
    wildSub.push(`${pick(WORDS)}.deep.${wilds.length ? pick(wilds) : 'none.com'}`);
    miss.push(`${pick(WORDS)}${i}.unlisted-${Math.floor(r() * 1e6)}.${pick(TLDS)}`);
  }
  return { exact, wildSub, miss };
}

export const toText = (rules: readonly Rule[]): string =>
  rules.map((x) => `${x.pattern} ${x.action.toUpperCase()}`).join('\n');
