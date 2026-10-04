import { Database, IdbPacRepository, IdbRuleRepository } from './idb.ts';
import {
  chromeArea,
  type KvArea,
  KvProxyRepository,
  KvRevisionStore,
  KvSettingsRepository,
  KvStateRepository,
} from './kv.ts';
import type { Repositories } from './repositories.ts';

export type { Repositories } from './repositories.ts';

export function createRepositories(kv: KvArea = chromeArea(), idb: IDBFactory = indexedDB): Repositories {
  const db = new Database(idb);
  return {
    rules: new IdbRuleRepository(db),
    pacs: new IdbPacRepository(db),
    proxies: new KvProxyRepository(kv),
    settings: new KvSettingsRepository(kv),
    revision: new KvRevisionStore(kv),
    state: new KvStateRepository(kv),
  };
}
