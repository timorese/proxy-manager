import { compilePac } from '../pac/compiler.ts';
import { validatePacSource } from '../pac/pac-source.ts';
import { type ApplyPlan, applyPlan, type ProxyApi } from '../proxy/apply.ts';
import { validateProxy } from '../proxy/serialize.ts';
import { hashString } from '../shared/hash.ts';
import type { SyncResult } from '../shared/messages.ts';
import type { Repositories } from '../storage/index.ts';
import type { AppError, ErrorCode, RuntimeState } from '../types/index.ts';

export interface SyncDeps {
  repos: Repositories;
  proxyApi: ProxyApi;
  now?: () => number;
}

export interface SyncOptions {
  /** Ignore `appliedRev` / `appliedHash` shortcuts (install, update, user pressed "re-apply"). */
  force?: boolean;
}

/**
 * The one place where configuration becomes browser proxy settings:
 *
 *   revision check ──same──▶ stop            (0 reads, 0 compiles)
 *        │ changed
 *        ▼
 *   read config ─▶ normalize ─▶ compile ─▶ hash ──same──▶ stop (record rev only)
 *                                            │ different
 *                                            ▼
 *                                   chrome.proxy.settings.set()
 *
 * Stateless between calls: everything it needs after a worker restart is in storage.
 */
export class SyncEngine {
  private readonly repos: Repositories;
  private readonly proxyApi: ProxyApi;
  private readonly now: () => number;
  private current: Promise<SyncResult> | undefined;
  private queued: Promise<SyncResult> | undefined;
  private queuedForce = false;

  constructor(deps: SyncDeps) {
    this.repos = deps.repos;
    this.proxyApi = deps.proxyApi;
    this.now = deps.now ?? Date.now;
  }

  /** Calls are serialised and coalesced: at most one run in flight plus one queued. */
  sync(opts: SyncOptions = {}): Promise<SyncResult> {
    if (!this.current) {
      const p = this.run(opts).finally(() => {
        if (this.current === p) this.current = undefined;
      });
      this.current = p;
      return p;
    }
    if (opts.force) this.queuedForce = true;
    if (!this.queued) {
      const after = this.current;
      const q = after
        .catch(() => undefined)
        .then(() => {
          const force = this.queuedForce;
          this.queued = undefined;
          this.queuedForce = false;
          const p = this.run({ force }).finally(() => {
            if (this.current === p) this.current = undefined;
          });
          this.current = p;
          return p;
        });
      this.queued = q;
    }
    return this.queued;
  }

  private async run(opts: SyncOptions): Promise<SyncResult> {
    const { repos } = this;
    const [rev, prev] = await Promise.all([repos.revision.get(), repos.state.get()]);
    if (!opts.force && rev !== '' && rev === prev.appliedRev) {
      return { applied: false, skipped: 'up-to-date', hash: prev.appliedHash, state: prev };
    }

    const [settings, proxies, rules, sources] = await Promise.all([
      repos.settings.get(),
      repos.proxies.list(),
      repos.rules.getAll(),
      repos.pacs.list(),
    ]);
    const errors: AppError[] = [];
    const at = this.now();
    const err = (code: ErrorCode, message: string) => errors.push({ code, message, at });

    let plan: ApplyPlan;
    let rulesCompiled = 0;
    let pacBytes = 0;
    const enabledProxies = proxies.filter((p) => p.enabled);
    for (const p of enabledProxies) {
      const e = validateProxy(p);
      if (e) err('invalid_proxy', `${p.host}:${p.port}: ${e}`);
    }

    if (!settings.enabled) {
      plan = { kind: 'clear' };
    } else {
      const wanted = sources.filter((s) => s.enabled);
      const bodies = await repos.pacs.getBodies(wanted.map((s) => s.id));
      const usable: { id: string; text: string }[] = [];
      for (const s of wanted) {
        const body = bodies.get(s.id);
        if (!body) {
          err('pac_compile_failed', `${s.name}: no downloaded script yet`);
          continue;
        }
        const check = validatePacSource(body);
        if (check.ok) usable.push({ id: s.id, text: body });
        else err('pac_compile_failed', `${s.name}: ${check.reason}`);
      }
      const res = compilePac({
        mode: settings.mode,
        failoverDirect: settings.failoverDirect,
        bypassLocal: settings.bypassLocal,
        proxies: enabledProxies,
        rules: rules.filter((r) => r.enabled),
        sources: usable,
      });
      if (res.stats.invalid > 0) err('invalid_rule', `${res.stats.invalid} invalid rule(s) ignored`);
      rulesCompiled = res.rulesCompiled;
      pacBytes = res.text.length;
      plan = res.kind === 'pac' ? { kind: 'pac', data: res.text } : { kind: 'direct' };
    }

    const hash = plan.kind === 'pac' ? await hashString(plan.data) : plan.kind;
    const base: RuntimeState = {
      ...prev,
      appliedRev: rev,
      appliedAt: prev.appliedAt,
      rulesCompiled,
      rulesTotal: rules.length,
      proxiesCount: enabledProxies.length,
      pacBytes,
    };

    if (!opts.force && hash === prev.appliedHash && plan.kind === prev.appliedKind) {
      // Identical configuration: do NOT touch chrome.proxy. Keep runtime errors (they describe the applied PAC).
      const keep = prev.errors.filter(
        (e) => e.code === 'proxy_runtime_error' || e.code === 'controlled_by_other',
      );
      const state: RuntimeState = { ...base, errors: [...errors, ...keep] };
      await repos.state.set(state);
      return { applied: false, skipped: 'same-hash', hash, state };
    }

    try {
      await applyPlan(this.proxyApi, plan);
    } catch (e) {
      err('proxy_rejected', e instanceof Error ? e.message : String(e));
      // appliedRev intentionally NOT advanced so the next sync retries.
      const state: RuntimeState = { ...base, appliedRev: prev.appliedRev, errors };
      await repos.state.set(state);
      return { applied: false, hash, state };
    }

    if (plan.kind !== 'clear') {
      const ctl = await this.proxyApi.get({ incognito: false }).catch(() => undefined);
      if (ctl?.levelOfControl === 'controlled_by_other_extensions') {
        err('controlled_by_other', 'Another extension controls the proxy settings');
      }
    }
    const state: RuntimeState = {
      ...base,
      appliedHash: hash,
      appliedKind: plan.kind,
      appliedAt: this.now(),
      errors,
    };
    await repos.state.set(state);
    return { applied: true, hash, state };
  }

  /** Runtime PAC/proxy errors reported by chrome.proxy.onProxyError. Cheap: one state write, deduplicated. */
  async recordRuntimeError(message: string): Promise<void> {
    const state = await this.repos.state.get();
    if (state.errors.some((e) => e.code === 'proxy_runtime_error' && e.message === message)) return;
    const errors = [
      ...state.errors.filter((e) => e.code !== 'proxy_runtime_error'),
      { code: 'proxy_runtime_error' as const, message, at: this.now() },
    ];
    await this.repos.state.set({ ...state, errors });
  }

  /**
   * Startup check: O(1), no compile. Re-applies only when the browser lost our settings
   * (e.g. profile reset) while we are supposed to be active.
   */
  async verify(): Promise<void> {
    const settings = await this.repos.settings.get();
    if (!settings.enabled) return;
    const ctl = await this.proxyApi.get({ incognito: false });
    if (ctl.levelOfControl === 'controllable_by_this_extension') await this.sync({ force: true });
  }
}
