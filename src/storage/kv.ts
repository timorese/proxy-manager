import { newRev } from '../shared/ids.ts';
import {
  DEFAULT_SETTINGS,
  EMPTY_STATE,
  type ProxyServer,
  type RuntimeState,
  type Settings,
} from '../types/index.ts';
import type { ProxyRepository, RevisionStore, SettingsRepository, StateRepository } from './repositories.ts';

/** The subset of chrome.storage.StorageArea we use. Injectable for tests. */
export interface KvArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const KEYS = {
  settings: 'settings',
  proxies: 'proxies',
  rev: 'rev',
  state: 'state',
  schema: 'schema',
} as const;

export const chromeArea = (): KvArea => chrome.storage.local as unknown as KvArea;

export class KvSettingsRepository implements SettingsRepository {
  private readonly kv: KvArea;
  constructor(kv: KvArea) {
    this.kv = kv;
  }
  async get(): Promise<Settings> {
    const r = await this.kv.get(KEYS.settings);
    return { ...DEFAULT_SETTINGS, ...(r[KEYS.settings] as Partial<Settings> | undefined) };
  }
  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()), ...patch };
    await this.kv.set({ [KEYS.settings]: next });
    return next;
  }
}

export class KvProxyRepository implements ProxyRepository {
  private readonly kv: KvArea;
  constructor(kv: KvArea) {
    this.kv = kv;
  }
  async list(): Promise<ProxyServer[]> {
    const r = await this.kv.get(KEYS.proxies);
    return (r[KEYS.proxies] as ProxyServer[] | undefined) ?? [];
  }
  async save(proxies: readonly ProxyServer[]): Promise<void> {
    await this.kv.set({ [KEYS.proxies]: proxies });
  }
}

export class KvRevisionStore implements RevisionStore {
  private readonly kv: KvArea;
  constructor(kv: KvArea) {
    this.kv = kv;
  }
  async get(): Promise<string> {
    const r = await this.kv.get(KEYS.rev);
    return (r[KEYS.rev] as string | undefined) ?? '';
  }
  async bump(): Promise<string> {
    const rev = newRev();
    await this.kv.set({ [KEYS.rev]: rev });
    return rev;
  }
}

export class KvStateRepository implements StateRepository {
  private readonly kv: KvArea;
  constructor(kv: KvArea) {
    this.kv = kv;
  }
  async get(): Promise<RuntimeState> {
    const r = await this.kv.get(KEYS.state);
    return { ...EMPTY_STATE, ...(r[KEYS.state] as Partial<RuntimeState> | undefined) };
  }
  async set(state: RuntimeState): Promise<void> {
    await this.kv.set({ [KEYS.state]: state });
  }
}
