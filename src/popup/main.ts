import { $ } from './dom.ts';
import { repos, saveSettings, store, syncNow } from './store.ts';
import { applyTheme } from './theme.ts';
import { createHomeView } from './views/home.ts';
import type { View } from './views/types.ts';

type Tab = 'proxy' | 'pac' | 'rules' | 'settings';

// Home is in the entry chunk (needed for first paint). Other tabs are separate chunks loaded on first visit.
const factories: Record<Tab, () => Promise<View> | View> = {
  proxy: createHomeView,
  pac: async () => (await import('./views/pacs.ts')).createPacsView(),
  rules: async () => (await import('./views/rules.ts')).createRulesView(),
  settings: async () => (await import('./views/settings.ts')).createSettingsView(),
};
const views = new Map<Tab, View>();
const host = $('#view');
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs button')];

async function show(tab: Tab): Promise<void> {
  for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  let v = views.get(tab);
  if (!v) {
    v = await factories[tab]();
    views.set(tab, v);
  }
  host.replaceChildren(v.el);
  v.onShow?.();
  try {
    localStorage.setItem('tab', tab);
  } catch {}
}

for (const b of tabs) b.addEventListener('click', () => void show(b.dataset.tab as Tab));

async function boot(): Promise<void> {
  const power = $<HTMLInputElement>('#power');
  const snap = await store.load(); // the ONLY storage read needed for first paint
  applyTheme(snap.settings.theme);
  power.checked = snap.settings.enabled;
  power.disabled = false;

  let initial: Tab = 'proxy';
  try {
    const t = localStorage.getItem('tab');
    if (t === 'pac' || t === 'rules' || t === 'settings') initial = t;
  } catch {}
  await show(initial);

  power.addEventListener('change', () => {
    // Toggle applies immediately (no debounce): write once, then ask the worker to apply and report.
    void saveSettings({ enabled: power.checked })
      .then(() => syncNow())
      .catch(() => {});
  });
  store.subscribe((s, changed) => {
    if (changed.has('settings')) power.checked = s.settings.enabled;
  });

  // Self-heal: if a debounced rebuild was lost (worker killed mid-debounce), nudge it. No-op when up to date.
  if (snap.rev !== '' && snap.rev !== snap.state.appliedRev) void syncNow().catch(() => {});
  void repos; // repositories are created lazily; IndexedDB is opened only when a view needs it
}

void boot();
