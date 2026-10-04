import { IDBFactory } from 'fake-indexeddb';
import { SyncEngine } from '../../src/background/sync.ts';
import type { ProxyApi } from '../../src/proxy/apply.ts';
import { createRepositories, type Repositories } from '../../src/storage/index.ts';
import type { KvArea } from '../../src/storage/kv.ts';
import type { FetchMeta, PacSource, ProxyServer, Rule } from '../../src/types/index.ts';

export class MemoryKv implements KvArea {
  data: Record<string, unknown> = {};
  reads = 0;
  writes = 0;
  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    this.reads++;
    const out: Record<string, unknown> = {};
    for (const k of Array.isArray(keys) ? keys : [keys])
      if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    this.writes++;
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v);
  }
}

export interface FakeProxy extends ProxyApi {
  calls: {
    op: 'set' | 'clear';
    value?: { mode: string; pacScript?: { data: string; mandatory: boolean } };
  }[];
  level: string;
  failNextSet?: string;
  /** Last PAC text passed to set(). */
  pac(): string;
}

export function fakeProxyApi(): FakeProxy {
  const api: FakeProxy = {
    calls: [],
    level: 'controlled_by_this_extension',
    async set(d) {
      if (api.failNextSet) {
        const m = api.failNextSet;
        api.failNextSet = undefined;
        throw new Error(m);
      }
      api.calls.push({ op: 'set', value: d.value as never });
    },
    async clear() {
      api.calls.push({ op: 'clear' });
    },
    async get() {
      return { levelOfControl: api.level };
    },
    pac() {
      const last = [...api.calls].reverse().find((c) => c.value?.pacScript);
      return last?.value?.pacScript?.data ?? '';
    },
  };
  return api;
}

export function makeEnv(now = () => 1_700_000_000_000) {
  const kv = new MemoryKv();
  const repos: Repositories = createRepositories(kv, new IDBFactory());
  const proxy = fakeProxyApi();
  const engine = new SyncEngine({ repos, proxyApi: proxy, now });
  return { kv, repos, proxy, engine };
}

export const emptyMeta = (over: Partial<FetchMeta> = {}): FetchMeta => ({
  lastAttemptAt: 0,
  lastSuccessAt: 0,
  etag: '',
  lastModified: '',
  hash: '',
  bytes: 0,
  error: '',
  ...over,
});

export const pacSource = (id: string, over: Partial<PacSource> = {}): PacSource => ({
  id,
  name: id,
  kind: 'inline',
  url: '',
  enabled: true,
  refreshMinutes: 0,
  fetch: emptyMeta(),
  ...over,
});

export const proxyServer = (
  id: string,
  host: string,
  port = 1080,
  scheme: ProxyServer['scheme'] = 'socks5',
  enabled = true,
): ProxyServer => ({
  id,
  scheme,
  host,
  port,
  enabled,
});

export const rule = (pattern: string, action: Rule['action'], enabled = true): Rule => ({
  pattern,
  action,
  enabled,
});
