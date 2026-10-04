import { hashString } from '../shared/hash.ts';
import type { Repositories } from '../storage/index.ts';
import { chromeArea } from '../storage/kv.ts';
import { type LegacyData, type MigrationPlan, mapLegacy } from './legacy.ts';

const FLAG = 'legacyMigrated';

/** Applies a plan with batched writes: one rules transaction, one write per small store. */
export async function applyMigration(plan: MigrationPlan, repos: Repositories): Promise<void> {
  await repos.rules.putMany(plan.rules);
  if (plan.proxies.length > 0) await repos.proxies.save(plan.proxies);
  for (const { source, body } of plan.pacs) {
    await repos.pacs.put({ ...source, fetch: { ...source.fetch, hash: await hashString(body) } }, body);
  }
  await repos.settings.update(plan.settings);
  await repos.revision.bump();
}

function readLegacyIdb(): Promise<LegacyData['pacScripts']> {
  return new Promise((resolve) => {
    let existed = true;
    const r = indexedDB.open('PacProxyManagerDB');
    r.onupgradeneeded = () => {
      existed = false; // we just created an empty DB by opening it: abort and remove it again
      r.transaction?.abort();
    };
    r.onerror = () => {
      if (!existed) indexedDB.deleteDatabase('PacProxyManagerDB');
      resolve(undefined);
    };
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('pacScripts')) {
        db.close();
        return resolve(undefined);
      }
      const all = db.transaction('pacScripts', 'readonly').objectStore('pacScripts').getAll();
      all.onsuccess = () => {
        db.close();
        resolve(all.result as LegacyData['pacScripts']);
      };
      all.onerror = () => {
        db.close();
        resolve(undefined);
      };
    };
  });
}

/**
 * If this build is installed over the legacy extension (same extension id) its data is right there.
 * Runs once (flag in storage) and never on a profile that has no legacy data.
 */
export async function runInPlaceMigration(repos: Repositories): Promise<boolean> {
  const kv = chromeArea();
  if ((await kv.get(FLAG))[FLAG]) return false;
  const stored = (await kv.get([
    'domainExceptions',
    'proxies',
    'proxyActive',
    'overridePacScript',
  ])) as LegacyData;
  const hasLegacyKv = stored.domainExceptions !== undefined || Array.isArray(stored.proxies);
  const pacScripts = await readLegacyIdb();
  if (!hasLegacyKv && !pacScripts?.length) return false;
  const plan = mapLegacy({ ...stored, pacScripts });
  await applyMigration(plan, repos);
  await kv.set({ [FLAG]: true });
  return true;
}
