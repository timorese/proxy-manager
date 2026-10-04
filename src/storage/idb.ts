import type { PacSource, Rule } from '../types/index.ts';
import type { PacRepository, RuleRepository } from './repositories.ts';

export const DB_NAME = 'ppm2';
export const DB_VERSION = 1;
const RULES = 'rules';
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
        if (!db.objectStoreNames.contains(RULES)) db.createObjectStore(RULES, { keyPath: 'pattern' });
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

export class IdbRuleRepository implements RuleRepository {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async getAll(): Promise<Rule[]> {
    const db = await this.db.open();
    return req(db.transaction(RULES, 'readonly').objectStore(RULES).getAll() as IDBRequest<Rule[]>);
  }

  async count(): Promise<number> {
    const db = await this.db.open();
    return req(db.transaction(RULES, 'readonly').objectStore(RULES).count());
  }

  async putMany(rules: readonly Rule[]): Promise<void> {
    if (rules.length === 0) return;
    const db = await this.db.open();
    const tx = db.transaction(RULES, 'readwrite');
    const store = tx.objectStore(RULES);
    for (let i = 0; i < rules.length; i++) store.put(rules[i]);
    await done(tx);
  }

  async deleteMany(patterns: readonly string[]): Promise<void> {
    if (patterns.length === 0) return;
    const db = await this.db.open();
    const tx = db.transaction(RULES, 'readwrite');
    const store = tx.objectStore(RULES);
    for (let i = 0; i < patterns.length; i++) store.delete(patterns[i]!);
    await done(tx);
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
