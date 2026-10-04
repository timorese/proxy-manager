import type { PacSource, Rule } from '../types/index.ts';
import type { PacRepository, RuleRepository } from './repositories.ts';

export const DB_NAME = 'ppm2';
export const DB_VERSION = 1;
const RULES = 'ruleBuckets';
const PACS = 'pacs';
const BODIES = 'pacBodies';

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** Opens lazily and caches the handle for the lifetime of the page / worker instance. */
export class Database {
  private p: Promise<IDBDatabase> | undefined;
  private readonly factory: IDBFactory;
  constructor(factory: IDBFactory = indexedDB) {
    this.factory = factory;
  }

  open(): Promise<IDBDatabase> {
    this.p ??= new Promise((resolve, reject) => {
      const r = this.factory.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(RULES)) db.createObjectStore(RULES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(PACS)) db.createObjectStore(PACS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(BODIES)) db.createObjectStore(BODIES);
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => {
          db.close();
          this.p = undefined;
        };
        resolve(db);
      };
      r.onerror = () => {
        this.p = undefined;
        reject(r.error);
      };
    });
    return this.p;
  }
}

/**
 * Rules are stored in BUCKET_COUNT records of ~N/256 rules each, not one record per rule.
 * Measured in Chromium (benchmarks/idb-layout.mjs): 50 000 per-rule puts block the main thread ~850 ms
 * and take 3.4 s to commit; 256 bucket puts take ~60 ms / 72 ms. A single-rule edit rewrites ~200 rules.
 * `bucketOf` is part of the on-disk format: do not change it without a schema migration.
 */
export const BUCKET_COUNT = 256;
export function bucketOf(pattern: string): number {
  let h = 2166136261;
  for (let i = 0; i < pattern.length; i++) {
    h ^= pattern.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % BUCKET_COUNT;
}

function groupByBucket<T>(items: readonly T[], key: (t: T) => string): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const it of items) {
    const id = bucketOf(key(it));
    const g = groups.get(id);
    if (g) g.push(it);
    else groups.set(id, [it]);
  }
  return groups;
}

interface Bucket {
  id: number;
  rules: Rule[];
}

export class IdbRuleRepository implements RuleRepository {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async getAll(): Promise<Rule[]> {
    const db = await this.db.open();
    const buckets = await req(
      db.transaction(RULES, 'readonly').objectStore(RULES).getAll() as IDBRequest<Bucket[]>,
    );
    const out: Rule[] = [];
    for (const b of buckets) for (let i = 0; i < b.rules.length; i++) out.push(b.rules[i]!);
    return out;
  }

  async count(): Promise<number> {
    const db = await this.db.open();
    const buckets = await req(
      db.transaction(RULES, 'readonly').objectStore(RULES).getAll() as IDBRequest<Bucket[]>,
    );
    return buckets.reduce((n, b) => n + b.rules.length, 0);
  }

  async getMany(patterns: readonly string[]): Promise<Rule[]> {
    if (patterns.length === 0) return [];
    const wanted = new Set(patterns);
    const groups = groupByBucket(patterns, (p) => p);
    const db = await this.db.open();
    const store = db.transaction(RULES, 'readonly').objectStore(RULES);
    const out: Rule[] = [];
    await Promise.all(
      [...groups.keys()].map(async (id) => {
        const b = await req(store.get(id) as IDBRequest<Bucket | undefined>);
        for (const r of b?.rules ?? []) if (wanted.has(r.pattern)) out.push(r);
      }),
    );
    return out;
  }

  /** ONE transaction: read-modify-write of every touched bucket. */
  private async modify(
    ids: Iterable<number>,
    edit: (bucket: Map<string, Rule>, id: number) => void,
  ): Promise<void> {
    const db = await this.db.open();
    const tx = db.transaction(RULES, 'readwrite');
    const store = tx.objectStore(RULES);
    for (const id of ids) {
      const get = store.get(id) as IDBRequest<Bucket | undefined>;
      get.onsuccess = () => {
        const map = new Map<string, Rule>();
        for (const r of get.result?.rules ?? []) map.set(r.pattern, r);
        edit(map, id);
        if (map.size === 0) store.delete(id);
        else store.put({ id, rules: [...map.values()] } satisfies Bucket);
      };
    }
    await done(tx);
  }

  async putMany(rules: readonly Rule[]): Promise<void> {
    if (rules.length === 0) return;
    const groups = groupByBucket(rules, (r) => r.pattern);
    await this.modify(groups.keys(), (map, id) => {
      for (const r of groups.get(id)!) map.set(r.pattern, r);
    });
  }

  async deleteMany(patterns: readonly string[]): Promise<void> {
    if (patterns.length === 0) return;
    const groups = groupByBucket(patterns, (p) => p);
    await this.modify(groups.keys(), (map, id) => {
      for (const p of groups.get(id)!) map.delete(p);
    });
  }

  async clear(): Promise<void> {
    const db = await this.db.open();
    const tx = db.transaction(RULES, 'readwrite');
    tx.objectStore(RULES).clear();
    await done(tx);
  }
}

export class IdbPacRepository implements PacRepository {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async list(): Promise<PacSource[]> {
    const db = await this.db.open();
    return req(db.transaction(PACS, 'readonly').objectStore(PACS).getAll() as IDBRequest<PacSource[]>);
  }

  async get(id: string): Promise<PacSource | undefined> {
    const db = await this.db.open();
    return req(
      db.transaction(PACS, 'readonly').objectStore(PACS).get(id) as IDBRequest<PacSource | undefined>,
    );
  }

  async put(source: PacSource, body?: string): Promise<void> {
    const db = await this.db.open();
    const tx = db.transaction([PACS, BODIES], 'readwrite');
    tx.objectStore(PACS).put(source);
    if (body !== undefined) tx.objectStore(BODIES).put(body, source.id);
    await done(tx);
  }

  async delete(id: string): Promise<void> {
    const db = await this.db.open();
    const tx = db.transaction([PACS, BODIES], 'readwrite');
    tx.objectStore(PACS).delete(id);
    tx.objectStore(BODIES).delete(id);
    await done(tx);
  }

  async getBody(id: string): Promise<string | undefined> {
    const db = await this.db.open();
    return req(
      db.transaction(BODIES, 'readonly').objectStore(BODIES).get(id) as IDBRequest<string | undefined>,
    );
  }

  async getBodies(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const db = await this.db.open();
    const store = db.transaction(BODIES, 'readonly').objectStore(BODIES);
    await Promise.all(
      ids.map(async (id) => {
        const body = await req(store.get(id) as IDBRequest<string | undefined>);
        if (body !== undefined) out.set(id, body);
      }),
    );
    return out;
  }
}
