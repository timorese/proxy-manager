/**
 * MV3 service worker. Event driven, stateless, no timers other than one short debounce.
 * All listeners are registered synchronously at top level so Chrome can wake the worker for them.
 * Nothing here runs on a schedule except `chrome.alarms` (only when a remote PAC has a refresh interval).
 */

import { runInPlaceMigration } from '../migration/in-place.ts';
import { chromeProxyApi } from '../proxy/apply.ts';
import type { RefreshResult, Request, Response, SyncResult } from '../shared/messages.ts';
import { createRepositories } from '../storage/index.ts';
import { chromeArea } from '../storage/kv.ts';
import { ensureSchema } from '../storage/schema.ts';
import { SyncEngine } from './sync.ts';
import { ALARM_NAME, ensureAlarm, refreshSources } from './updater.ts';

const DEBOUNCE_MS = 250;
const ERROR_THROTTLE_MS = 5_000;

let services: { repos: ReturnType<typeof createRepositories>; engine: SyncEngine } | undefined;
function svc() {
  // Re-created lazily after every worker restart; holds no state that is not also in storage.
  if (!services) {
    const repos = createRepositories();
    services = { repos, engine: new SyncEngine({ repos, proxyApi: chromeProxyApi() }) };
  }
  return services;
}

async function afterSync(r: SyncResult): Promise<void> {
  const { repos } = svc();
  void chrome.action.setBadgeText({
    text: r.state.appliedKind === 'clear' ? '' : r.state.errors.length ? '!' : 'ON',
  });
  void chrome.action.setBadgeBackgroundColor({ color: r.state.errors.length ? '#d97706' : '#16a34a' });
  await ensureAlarm(chrome.alarms as never, await repos.pacs.list());
}

async function doSync(force = false): Promise<SyncResult> {
  const r = await svc().engine.sync({ force });
  if (r.applied || r.skipped !== 'up-to-date') await afterSync(r);
  return r;
}

async function doRefresh(id?: string): Promise<RefreshResult> {
  const { repos } = svc();
  const res = await refreshSources({ repos }, id);
  // refreshSources bumps the revision when a body changed; the sync below is then a real rebuild, otherwise a no-op.
  res.sync = await doSync(false);
  return res;
}

let debounce: ReturnType<typeof setTimeout> | undefined;
let lastErrorAt = 0;

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const { repos } = svc();
    await ensureSchema(chromeArea());
    await runInPlaceMigration(repos);
    await repos.revision.bump();
    await doSync(true);
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await svc().engine.verify();
    await ensureAlarm(chrome.alarms as never, await svc().repos.pacs.list());
  })();
});

// The popup (or the updater) bumped the revision: rebuild once, after the burst of edits settles.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.rev) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void doSync(false), DEBOUNCE_MS);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void doRefresh();
});

chrome.proxy.onProxyError.addListener((details) => {
  const t = Date.now();
  if (t - lastErrorAt < ERROR_THROTTLE_MS) return; // PAC errors can fire per request: do almost nothing
  lastErrorAt = t;
  void svc().engine.recordRuntimeError(
    `${details.error}${details.details ? `: ${details.details}` : ''}`.slice(0, 300),
  );
});

chrome.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  const reply = <T>(p: Promise<T>) =>
    p.then(
      (result) => sendResponse({ ok: true, result } satisfies Response<T>),
      (e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Response<T>),
    );
  if (msg?.t === 'sync') {
    clearTimeout(debounce);
    reply(doSync(msg.force));
    return true;
  }
  if (msg?.t === 'refresh') {
    clearTimeout(debounce);
    reply(doRefresh(msg.id));
    return true;
  }
  return false;
});
