/** Thin, injectable wrapper over chrome.proxy.settings so the sync engine can be tested without Chrome. */
export interface ProxyApi {
  set(details: { value: object; scope: 'regular' }): Promise<void>;
  clear(details: { scope: 'regular' }): Promise<void>;
  get(details: { incognito: boolean }): Promise<{ levelOfControl: string }>;
}

export type ApplyPlan = { kind: 'clear' } | { kind: 'direct' } | { kind: 'pac'; data: string };

export const chromeProxyApi = (): ProxyApi => ({
  set: (d) => chrome.proxy.settings.set(d as chrome.types.ChromeSettingSetDetails<chrome.proxy.ProxyConfig>),
  clear: (d) => chrome.proxy.settings.clear(d),
  get: (d) => chrome.proxy.settings.get(d) as Promise<{ levelOfControl: string }>,
});

export async function applyPlan(api: ProxyApi, plan: ApplyPlan): Promise<void> {
  switch (plan.kind) {
    case 'clear':
      await api.clear({ scope: 'regular' });
      return;
    case 'direct':
      await api.set({ value: { mode: 'direct' }, scope: 'regular' });
      return;
    case 'pac':
      // mandatory:false -> if Chrome cannot use the script it falls back to DIRECT instead of blocking all traffic.
      await api.set({
        value: { mode: 'pac_script', pacScript: { data: plan.data, mandatory: false } },
        scope: 'regular',
      });
      return;
  }
}
