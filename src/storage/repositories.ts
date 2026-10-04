import type { PacSource, ProxyServer, Rule, RuntimeState, Settings } from '../types/index.ts';

/**
 * Repository interfaces. UI, service worker and tests depend on these only; no consumer touches
 * IndexedDB / chrome.storage directly. Every bulk method is ONE transaction / ONE write.
 */
export interface RuleRepository {
  getAll(): Promise<Rule[]>;
  count(): Promise<number>;
  /** Insert or overwrite by `pattern`. */
  putMany(rules: readonly Rule[]): Promise<void>;
  deleteMany(patterns: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface PacRepository {
  /** Metadata only: never loads script bodies. */
  list(): Promise<PacSource[]>;
  get(id: string): Promise<PacSource | undefined>;
  /** Writes metadata, and the body too when `body` is given. Toggling `enabled` passes no body. */
  put(source: PacSource, body?: string): Promise<void>;
  delete(id: string): Promise<void>;
  getBody(id: string): Promise<string | undefined>;
  getBodies(ids: readonly string[]): Promise<Map<string, string>>;
}

export interface ProxyRepository {
  list(): Promise<ProxyServer[]>;
  save(proxies: readonly ProxyServer[]): Promise<void>;
}

export interface SettingsRepository {
  get(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
}

/**
 * The revision is the only signal the service worker listens to. Any change to rules, proxies,
 * PAC sources or settings ends with `bump()`; the worker compares it with `RuntimeState.appliedRev`.
 */
export interface RevisionStore {
  get(): Promise<string>;
  bump(): Promise<string>;
}

export interface StateRepository {
  get(): Promise<RuntimeState>;
  set(state: RuntimeState): Promise<void>;
}

export interface Repositories {
  rules: RuleRepository;
  pacs: PacRepository;
  proxies: ProxyRepository;
  settings: SettingsRepository;
  revision: RevisionStore;
  state: StateRepository;
}
