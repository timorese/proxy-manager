import { newRev } from '../shared/ids.ts';
import type { RefreshResult, Request, Response, SyncResult } from '../shared/messages.ts';
import { createRepositories, type Repositories } from '../storage/index.ts';
import { KEYS } from '../storage/kv.ts';
import {
  DEFAULT_SETTINGS,
  EMPTY_STATE,
  type ProxyServer,
  type RuntimeState,
  type Settings,
} from '../types/index.ts';

export const repos: Repositories = createRepositories();

export interface Snapshot {
  settings: Settings;
  proxies: ProxyServer[];
  state: RuntimeState;
  rev: string;
}

type Listener = (s: Snapshot, changed: ReadonlySet<keyof Snapshot>) => void;

/**
 * The only "global state" of the popup: what lives in chrome.storage.local (small, loaded with ONE read).
 * Rules and PAC bodies are NOT here: views load them lazily from their repositories.
 * Subscribers get the set of changed keys so each view updates only its own DOM.
 */
class Store {
  snap: Snapshot = { settings: DEFAULT_SETTINGS, proxies: [], state: EMPTY_STATE, rev: '' };
  private listeners = new Set<Listener>();

  async load(): Promise<Snapshot> {
    const r = await chrome.storage.local.get([KEYS.settings, KEYS.proxies, KEYS.state, KEYS.rev]);
    this.snap = {
      settings: { ...DEFAULT_SETTINGS, ...(r[KEYS.settings] as Partial<Settings> | undefined) },
      proxies: (r[KEYS.proxies] as ProxyServer[] | undefined) ?? [],
      state: { ...EMPTY_STATE, ...(r[KEYS.state] as Partial<RuntimeState> | undefined) },
      rev: (r[KEYS.rev] as string | undefined) ?? '',
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const changed = new Set<keyof Snapshot>();
      const next = { ...this.snap };
      const settings = changes[KEYS.settings]?.newValue as Partial<Settings> | undefined;
      const proxies = changes[KEYS.proxies]?.newValue as ProxyServer[] | undefined;
      const state = changes[KEYS.state]?.newValue as Partial<RuntimeState> | undefined;
      const rev = changes[KEYS.rev]?.newValue as string | undefined;
      if (changes[KEYS.settings]) {
        next.settings = { ...DEFAULT_SETTINGS, ...settings };
        changed.add('settings');
      }
      if (changes[KEYS.proxies]) {
        next.proxies = proxies ?? [];
        changed.add('proxies');
      }
      if (changes[KEYS.state]) {
        next.state = { ...EMPTY_STATE, ...state };
        changed.add('state');
      }
      if (changes[KEYS.rev]) {
        next.rev = rev ?? '';
        changed.add('rev');
      }
      if (changed.size === 0) return;
      this.snap = next;
      this.emit(changed);
    });
    return this.snap;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(changed: ReadonlySet<keyof Snapshot>): void {
    for (const l of this.listeners) l(this.snap, changed);
  }
}

export const store = new Store();

/** Set when rules were changed outside the Rules view (e.g. "add site" on Home) so that view reloads next time. */
export const rulesState = { dirty: false };

/** Persist a configuration change. Storage write(s) + ONE revision bump; the worker rebuilds (debounced) on its own. */
export async function commit(): Promise<void> {
  await repos.revision.bump();
}

/** Settings change + revision bump in ONE storage write (one change event, one worker wake-up). */
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const next = { ...store.snap.settings, ...patch };
  store.snap = { ...store.snap, settings: next };
  await chrome.storage.local.set({ [KEYS.settings]: next, [KEYS.rev]: newRev() });
}

export async function saveProxies(proxies: ProxyServer[]): Promise<void> {
  store.snap = { ...store.snap, proxies };
  await chrome.storage.local.set({ [KEYS.proxies]: proxies, [KEYS.rev]: newRev() });
}

async function send<T>(msg: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as Response<T> | undefined;
  if (!res) throw new Error('service worker did not answer');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

/** Apply right now (used by the master toggle and explicit buttons): returns the outcome, wakes the worker if needed. */
export const syncNow = (force = false): Promise<SyncResult> => send<SyncResult>({ t: 'sync', force });
export const refreshPac = (id?: string): Promise<RefreshResult> =>
  id ? send({ t: 'refresh', id }) : send({ t: 'refresh' });
