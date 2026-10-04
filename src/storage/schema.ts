import { KEYS, type KvArea } from './kv.ts';

/**
 * Versioned schema migrations for *our own* data. (Importing data from the legacy extension is
 * a different concern, see src/migration.) Each step runs once, in order, and must be idempotent.
 */
export const CURRENT_SCHEMA = 1;

export type Migration = (kv: KvArea) => Promise<void>;

export const MIGRATIONS: Record<number, Migration> = {
  // v1: first release of the new data model. Nothing to transform; defaults are merged on read.
  1: async () => {},
};

export async function ensureSchema(
  kv: KvArea,
  migrations: Record<number, Migration> = MIGRATIONS,
  target = CURRENT_SCHEMA,
): Promise<number> {
  const stored = ((await kv.get(KEYS.schema))[KEYS.schema] as number | undefined) ?? 0;
  if (stored >= target) return stored;
  for (let v = stored + 1; v <= target; v++) {
    const m = migrations[v];
    if (m) await m(kv);
    await kv.set({ [KEYS.schema]: v }); // persist per step so a crash resumes where it stopped
  }
  return target;
}
