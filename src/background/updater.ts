import { validatePacSource } from '../pac/pac-source.ts';
import { hashString } from '../shared/hash.ts';
import type { RefreshResult } from '../shared/messages.ts';
import type { Repositories } from '../storage/index.ts';
import type { PacSource } from '../types/index.ts';

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 1024 * 1024;
export const ALARM_NAME = 'pac-refresh';

export interface UpdaterDeps {
  repos: Repositories;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export type RefreshOutcome = 'updated' | 'not-modified' | 'failed' | 'skipped';

/**
 * Refreshes one remote PAC source. Invariants:
 *  - the stored (last known good) body is only replaced by a body that validated;
 *  - a failed attempt only touches metadata (`error`, `lastAttemptAt`);
 *  - 304 / identical hash never causes a rebuild.
 */
export async function refreshSource(source: PacSource, deps: UpdaterDeps): Promise<RefreshOutcome> {
  if (source.kind !== 'url') return 'skipped';
  const { repos } = deps;
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const t = now();
  const fail = async (message: string): Promise<RefreshOutcome> => {
    await repos.pacs.put({ ...source, fetch: { ...source.fetch, lastAttemptAt: t, error: message } });
    return 'failed';
  };

  const hasBody = source.fetch.lastSuccessAt > 0 && source.fetch.hash !== '';
  const headers: Record<string, string> = {
    Accept: 'application/x-ns-proxy-autoconfig, text/javascript, text/plain, */*',
  };
  if (hasBody && source.fetch.etag) headers['If-None-Match'] = source.fetch.etag;
  if (hasBody && source.fetch.lastModified) headers['If-Modified-Since'] = source.fetch.lastModified;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  let res: Response;
  let text = '';
  try {
    res = await doFetch(source.url, {
      headers,
      signal: ctl.signal,
      credentials: 'omit',
      cache: 'no-cache',
      redirect: 'follow',
    });
    if (res.status === 304) {
      await repos.pacs.put({
        ...source,
        fetch: { ...source.fetch, lastAttemptAt: t, lastSuccessAt: t, error: '' },
      });
      return 'not-modified';
    }
    if (!res.ok) return await fail(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BODY_BYTES) return await fail('script too large');
    text = await res.text();
  } catch (e) {
    return await fail(ctl.signal.aborted ? 'timeout' : e instanceof Error ? e.message : 'network error');
  } finally {
    clearTimeout(timer);
  }

  const check = validatePacSource(text);
  if (!check.ok) return await fail(`invalid script: ${check.reason}`);

  const hash = await hashString(text);
  const meta = {
    lastAttemptAt: t,
    lastSuccessAt: t,
    etag: res.headers.get('etag') ?? '',
    lastModified: res.headers.get('last-modified') ?? '',
    hash,
    bytes: text.length,
    error: '',
  };
  if (hash === source.fetch.hash && hasBody) {
    await repos.pacs.put({ ...source, fetch: meta }); // metadata only
    return 'not-modified';
  }
  await repos.pacs.put({ ...source, fetch: meta }, text);
  return 'updated';
}

export const isDue = (s: PacSource, now: number): boolean =>
  s.enabled &&
  s.kind === 'url' &&
  s.refreshMinutes > 0 &&
  now - s.fetch.lastAttemptAt >= s.refreshMinutes * 60_000 - 5_000;

/** Refreshes `only` (manual) or every due source (alarm). Bumps the revision once, only if a body changed. */
export async function refreshSources(deps: UpdaterDeps, only?: string): Promise<RefreshResult> {
  const now = (deps.now ?? Date.now)();
  const all = await deps.repos.pacs.list();
  const targets = only ? all.filter((s) => s.id === only) : all.filter((s) => isDue(s, now));
  const out: RefreshResult = { updated: 0, notModified: 0, failed: 0 };
  const results = await Promise.all(targets.map((s) => refreshSource(s, deps)));
  for (const r of results) {
    if (r === 'updated') out.updated++;
    else if (r === 'not-modified') out.notModified++;
    else if (r === 'failed') out.failed++;
  }
  if (out.updated > 0) await deps.repos.revision.bump();
  return out;
}

export interface AlarmsApi {
  get(name: string): Promise<{ periodInMinutes?: number } | undefined>;
  create(name: string, info: { periodInMinutes: number; delayInMinutes?: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
}

/** One alarm for all sources, at the shortest configured interval; removed when nothing needs refreshing. */
export async function ensureAlarm(alarms: AlarmsApi, sources: readonly PacSource[]): Promise<number> {
  const periods = sources
    .filter((s) => s.enabled && s.kind === 'url' && s.refreshMinutes > 0)
    .map((s) => s.refreshMinutes);
  if (periods.length === 0) {
    if (await alarms.get(ALARM_NAME)) await alarms.clear(ALARM_NAME);
    return 0;
  }
  const period = Math.max(1, Math.min(...periods));
  const existing = await alarms.get(ALARM_NAME);
  if (existing?.periodInMinutes !== period)
    await alarms.create(ALARM_NAME, { periodInMinutes: period, delayInMinutes: period });
  return period;
}
