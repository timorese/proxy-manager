import { describe, expect, it } from 'vitest';
import {
  ALARM_NAME,
  type AlarmsApi,
  ensureAlarm,
  isDue,
  refreshSource,
  refreshSources,
} from '../src/background/updater.ts';
import { hashString } from '../src/shared/hash.ts';
import { emptyMeta, makeEnv, pacSource } from './helpers/env.ts';

const GOOD = 'function FindProxyForURL(u,h){ return "DIRECT"; }';
const T0 = 1_700_000_000_000;

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const urlSource = (over = {}) =>
  pacSource('u', { kind: 'url', url: 'https://pac.example/p.pac', refreshMinutes: 10, ...over });

describe('remote PAC updater', () => {
  it('first download stores body + validators and reports "updated"', async () => {
    const { repos } = makeEnv();
    const { f, calls } = fakeFetch(
      () =>
        new Response(GOOD, { headers: { etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' } }),
    );
    await repos.pacs.put(urlSource());
    expect(await refreshSource(urlSource(), { repos, fetch: f, now: () => T0 })).toBe('updated');
    const s = await repos.pacs.get('u');
    expect(s?.fetch).toMatchObject({
      etag: '"v1"',
      lastSuccessAt: T0,
      error: '',
      hash: await hashString(GOOD),
    });
    expect(await repos.pacs.getBody('u')).toBe(GOOD);
    expect(calls[0]?.headers['If-None-Match']).toBeUndefined(); // nothing cached yet
  });

  it('sends conditional headers and treats 304 as "nothing changed" (no revision bump)', async () => {
    const { repos } = makeEnv();
    const src = urlSource({
      fetch: emptyMeta({ lastSuccessAt: 1, lastAttemptAt: 1, etag: '"v1"', lastModified: 'LM', hash: 'abc' }),
    });
    await repos.pacs.put(src, GOOD);
    const { f, calls } = fakeFetch(() => new Response(null, { status: 304 }));
    const revBefore = await repos.revision.bump();
    const res = await refreshSources({ repos, fetch: f, now: () => T0 }, 'u');
    expect(calls[0]?.headers['If-None-Match']).toBe('"v1"');
    expect(calls[0]?.headers['If-Modified-Since']).toBe('LM');
    expect(res).toMatchObject({ updated: 0, notModified: 1, failed: 0 });
    expect(await repos.revision.get()).toBe(revBefore);
    expect((await repos.pacs.get('u'))?.fetch.lastSuccessAt).toBe(T0);
  });

  it('200 with identical content (server ignores validators) does not bump the revision', async () => {
    const { repos } = makeEnv();
    const h = await hashString(GOOD);
    await repos.pacs.put(urlSource({ fetch: emptyMeta({ lastSuccessAt: 1, hash: h }) }), GOOD);
    const { f } = fakeFetch(() => new Response(GOOD));
    const rev = await repos.revision.bump();
    const res = await refreshSources({ repos, fetch: f, now: () => T0 }, 'u');
    expect(res.notModified).toBe(1);
    expect(await repos.revision.get()).toBe(rev);
  });

  it('changed content updates the body and bumps the revision once', async () => {
    const { repos } = makeEnv();
    await repos.pacs.put(
      urlSource({ fetch: emptyMeta({ lastSuccessAt: 1, hash: 'old' }) }),
      'OLD function FindProxyForURL(){}',
    );
    const { f } = fakeFetch(() => new Response(GOOD));
    const rev = await repos.revision.bump();
    const res = await refreshSources({ repos, fetch: f, now: () => T0 }, 'u');
    expect(res.updated).toBe(1);
    expect(await repos.revision.get()).not.toBe(rev);
    expect(await repos.pacs.getBody('u')).toBe(GOOD);
  });

  it('offline: keeps last good body, records the error, no revision bump', async () => {
    const { repos } = makeEnv();
    await repos.pacs.put(urlSource({ fetch: emptyMeta({ lastSuccessAt: 1, hash: 'h' }) }), GOOD);
    const { f } = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const rev = await repos.revision.bump();
    const res = await refreshSources({ repos, fetch: f, now: () => T0 }, 'u');
    expect(res.failed).toBe(1);
    expect(await repos.pacs.getBody('u')).toBe(GOOD);
    expect((await repos.pacs.get('u'))?.fetch).toMatchObject({
      error: 'Failed to fetch',
      lastAttemptAt: T0,
      lastSuccessAt: 1,
    });
    expect(await repos.revision.get()).toBe(rev);
  });

  it('HTTP errors, HTML error pages and truncated scripts never replace the good body', async () => {
    const { repos } = makeEnv();
    await repos.pacs.put(urlSource({ fetch: emptyMeta({ lastSuccessAt: 1, hash: 'h' }) }), GOOD);
    for (const [resp, msg] of [
      [new Response('nope', { status: 503 }), 'HTTP 503'],
      [new Response('<html><body>Error</body></html>'), 'HTML'],
      [new Response('function FindProxyForURL(u,h){ return "DIRECT"; '), 'unbalanced'],
      [new Response(''), 'empty'],
    ] as const) {
      const { f } = fakeFetch(() => resp.clone());
      const res = await refreshSources({ repos, fetch: f, now: () => T0 }, 'u');
      expect(res.failed).toBe(1);
      expect((await repos.pacs.get('u'))?.fetch.error).toContain(msg);
      expect(await repos.pacs.getBody('u')).toBe(GOOD);
    }
  });

  it('times out via AbortController', async () => {
    const { repos } = makeEnv();
    await repos.pacs.put(urlSource());
    const { f } = fakeFetch(
      (_u, init) =>
        new Promise((_res, rej) =>
          init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))),
        ),
    );
    const out = await refreshSource(urlSource(), { repos, fetch: f, now: () => T0, timeoutMs: 20 });
    expect(out).toBe('failed');
    expect((await repos.pacs.get('u'))?.fetch.error).toBe('timeout');
  });

  it('inline sources are never fetched', async () => {
    const { repos } = makeEnv();
    const { f, calls } = fakeFetch(() => new Response(GOOD));
    expect(await refreshSource(pacSource('i'), { repos, fetch: f })).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('alarm run only fetches sources that are due and enabled', () => {
    const due = urlSource({ fetch: emptyMeta({ lastAttemptAt: T0 - 11 * 60_000 }) });
    expect(isDue(due, T0)).toBe(true);
    expect(isDue(urlSource({ fetch: emptyMeta({ lastAttemptAt: T0 - 60_000 }) }), T0)).toBe(false);
    expect(isDue({ ...due, enabled: false }, T0)).toBe(false);
    expect(isDue({ ...due, refreshMinutes: 0 }, T0)).toBe(false);
  });
});

describe('chrome.alarms scheduling', () => {
  const fake = () => {
    const store = new Map<string, { periodInMinutes?: number }>();
    const log: string[] = [];
    const api: AlarmsApi = {
      get: async (n) => store.get(n),
      create: async (n, i) => {
        log.push(`create:${i.periodInMinutes}`);
        store.set(n, i);
      },
      clear: async (n) => {
        log.push('clear');
        return store.delete(n);
      },
    };
    return { api, log, store };
  };
  it('creates one alarm at the shortest interval, and is idempotent', async () => {
    const { api, log } = fake();
    const sources = [urlSource({ refreshMinutes: 60 }), urlSource({ id: 'v', refreshMinutes: 15 })];
    expect(await ensureAlarm(api, sources)).toBe(15);
    await ensureAlarm(api, sources);
    expect(log).toEqual(['create:15']);
  });
  it('removes the alarm when nothing needs refreshing', async () => {
    const { api, log, store } = fake();
    await ensureAlarm(api, [urlSource()]);
    expect(store.has(ALARM_NAME)).toBe(true);
    await ensureAlarm(api, [urlSource({ refreshMinutes: 0 })]);
    expect(store.has(ALARM_NAME)).toBe(false);
    expect(log.at(-1)).toBe('clear');
  });
});
