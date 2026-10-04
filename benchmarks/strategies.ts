import { performance } from 'node:perf_hooks';
import type { Action, Rule } from '../src/types/index.ts';
import type { LookupSets } from './data.ts';

type Trie = { a?: Action; w?: Action; c?: Record<string, Trie> };

function buildTrie(rules: readonly Rule[]): Trie {
  const root: Trie = { c: Object.create(null) };
  for (const r of rules) {
    const wild = r.pattern.charCodeAt(0) === 42;
    const labels = (wild ? r.pattern.slice(2) : r.pattern).split('.');
    let node = root;
    for (let i = labels.length - 1; i >= 0; i--) {
      node.c ??= Object.create(null);
      node = node.c![labels[i]!] ??= {};
    }
    if (wild) node.w = r.action;
    else node.a = r.action;
  }
  return root;
}

/** Same semantics as the PAC: exact first, then the most specific wildcard. */
function trieLookup(root: Trie, host: string): Action | undefined {
  const labels = host.split('.');
  let node: Trie | undefined = root;
  let wild: Action | undefined;
  for (let i = labels.length - 1; i >= 0 && node; i--) {
    node = node.c?.[labels[i]!];
    if (node?.w) wild = node.w;
    if (i === 0 && node?.a) return node.a;
  }
  return wild;
}

function measure(fn: (h: string) => unknown, hosts: string[], reps = 20): number {
  for (let i = 0; i < hosts.length; i++) fn(hosts[i]!); // warm-up
  let sink = 0;
  const t = performance.now();
  for (let r = 0; r < reps; r++) for (let i = 0; i < hosts.length; i++) if (fn(hosts[i]!)) sink++;
  const ns = ((performance.now() - t) * 1e6) / (hosts.length * reps);
  if (sink < 0) console.log(sink);
  return ns;
}

export function strategyComparison(rules: readonly Rule[], look: LookupSets) {
  const exactObj: Record<string, Action> = Object.create(null);
  const wildObj: Record<string, Action> = Object.create(null);
  const exactMap = new Map<string, Action>();
  const wildMap = new Map<string, Action>();
  const legacyKeys: Record<string, string> = {};
  for (const r of rules) {
    const wild = r.pattern.charCodeAt(0) === 42;
    const k = wild ? r.pattern.slice(2) : r.pattern;
    (wild ? wildObj : exactObj)[k] = r.action;
    (wild ? wildMap : exactMap).set(k, r.action);
    legacyKeys[r.pattern] = r.action;
  }
  const trie = buildTrie(rules);

  const objSuffix = (h: string) => {
    const e = exactObj[h];
    if (e) return e;
    let s = h;
    for (;;) {
      const a = wildObj[s];
      if (a) return a;
      const i = s.indexOf('.');
      if (i < 0) return undefined;
      s = s.slice(i + 1);
    }
  };
  const mapSuffix = (h: string) => {
    const e = exactMap.get(h);
    if (e) return e;
    let s = h;
    for (;;) {
      const a = wildMap.get(s);
      if (a) return a;
      const i = s.indexOf('.');
      if (i < 0) return undefined;
      s = s.slice(i + 1);
    }
  };
  // The original extension: exact key, then loop over every key and test startsWith('*.') + endsWith
  const legacy = (h: string) => {
    if (legacyKeys[h]) return legacyKeys[h];
    for (const d in legacyKeys) {
      if (d.startsWith('*.')) {
        const b = d.slice(2);
        if (h === b || h.endsWith(`.${b}`)) return legacyKeys[d];
      }
    }
    return undefined;
  };

  const sets = { exact: look.exact, 'wildcard sub': look.wildSub, miss: look.miss } as const;
  const rows: Record<string, number | string>[] = [];
  const impls: [string, (h: string) => unknown][] = [
    ['legacy linear scan', legacy],
    ['null-proto object + suffix walk (shipped)', objSuffix],
    ['Map + suffix walk', mapSuffix],
    ['reversed-label trie', (h) => trieLookup(trie, h)],
  ];
  for (const [name, fn] of impls) {
    const reps = name.startsWith('legacy') ? 1 : 20;
    const row: Record<string, number | string> = { strategy: name };
    for (const [setName, hosts] of Object.entries(sets))
      row[`${setName} ns`] = Math.round(measure(fn, hosts, reps));
    rows.push(row);
  }
  return rows;
}
