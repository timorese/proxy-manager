import { applyMigration } from '../../migration/in-place.ts';
import { type LegacyData, mapLegacy } from '../../migration/legacy.ts';
import { buildDiagnostics } from '../../shared/diagnostics.ts';
import { CURRENT_SCHEMA } from '../../storage/schema.ts';
import type { Theme } from '../../types/index.ts';
import { h, setText } from '../dom.ts';
import { download } from '../format.ts';
import { repos, saveSettings, store, syncNow } from '../store.ts';
import { applyTheme } from '../theme.ts';
import type { View } from './types.ts';

export function createSettingsView(): View {
  const s = () => store.snap.settings;
  const theme = h(
    'select',
    { attrs: { 'aria-label': 'Theme' } },
    h('option', { value: 'auto', text: 'System' }),
    h('option', { value: 'light', text: 'Light' }),
    h('option', { value: 'dark', text: 'Dark' }),
  );
  theme.value = s().theme;
  theme.addEventListener('change', () => {
    applyTheme(theme.value as Theme);
    void chrome.storage.local.set({ settings: { ...s(), theme: theme.value } }); // cosmetic: no revision bump, no PAC work
  });

  const check = (label: string, hint: string, get: () => boolean, set: (v: boolean) => void) => {
    const box = h('input', { type: 'checkbox', checked: get(), on: { change: () => set(box.checked) } });
    return h(
      'label',
      { class: 'check', title: hint },
      box,
      h('span', null, label, h('div', { class: 'small muted', text: hint })),
    );
  };
  const failover = check(
    'Fall back to DIRECT if the proxy is down',
    'Appends "; DIRECT" to proxy chains',
    () => s().failoverDirect,
    (v) => void saveSettings({ failoverDirect: v }).then(() => syncNow()),
  );
  const bypass = check(
    'Bypass proxy for plain host names',
    'Names without a dot (intranet, localhost) go DIRECT unless a rule matches',
    () => s().bypassLocal,
    (v) => void saveSettings({ bypassLocal: v }).then(() => syncNow()),
  );

  const out = h('div', { class: 'small muted', attrs: { 'aria-live': 'polite' } });
  const diag = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Export diagnostics',
    on: {
      click: async () => {
        const [pacs, rules] = await Promise.all([repos.pacs.list(), repos.rules.getAll()]);
        const d = buildDiagnostics({
          version: chrome.runtime.getManifest().version,
          userAgent: navigator.userAgent,
          settings: s(),
          proxies: store.snap.proxies,
          pacs,
          state: store.snap.state,
          rulesTotal: rules.length,
          rulesEnabled: rules.filter((r) => r.enabled).length,
          schema: CURRENT_SCHEMA,
        });
        download('pac-proxy-diagnostics.json', JSON.stringify(d, null, 2), 'application/json');
        setText(out, 'Saved. The file contains no domains, hosts or URL paths.');
      },
    },
  });
  const reapply = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Re-apply now',
    on: {
      click: async () => {
        try {
          const r = await syncNow(true);
          setText(out, r.applied ? 'Applied.' : 'Nothing to apply.');
        } catch (e) {
          setText(out, e instanceof Error ? e.message : String(e));
        }
      },
    },
  });

  const legacyText = h('textarea', {
    rows: 4,
    placeholder: '{"domainExceptions":{…},"proxies":[…],"pacScripts":[…]}',
    attrs: { 'aria-label': 'Legacy export JSON', spellcheck: 'false' },
  });
  const legacyBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Import',
    on: {
      click: async () => {
        try {
          const plan = mapLegacy(JSON.parse(legacyText.value) as LegacyData);
          await applyMigration(plan, repos);
          void syncNow();
          legacyText.value = '';
          setText(
            out,
            `Imported ${plan.rules.length} rules, ${plan.proxies.length} proxies, ${plan.pacs.length} PAC scripts.${plan.warnings.length ? ` Notes: ${plan.warnings.slice(0, 3).join('; ')}` : ''}`,
          );
        } catch (e) {
          setText(out, `Import failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
  });

  const el = h(
    'div',
    { class: 'view-enter', style: 'display:flex;flex-direction:column;gap:10px' },
    h('section', { class: 'card' }, h('h3', { text: 'Behaviour' }), failover, bypass),
    h(
      'section',
      { class: 'card' },
      h('h3', { text: 'Appearance' }),
      h('div', { class: 'row between' }, h('span', { text: 'Theme' }), theme),
    ),
    h(
      'section',
      { class: 'card' },
      h('h3', { text: 'Maintenance' }),
      h('div', { class: 'row' }, reapply, diag),
    ),
    h(
      'section',
      { class: 'card' },
      h('h3', { text: 'Import from PAC Proxy Manager 1.x' }),
      h('div', {
        class: 'small muted',
        text: 'Paste the JSON produced by the export snippet in MIGRATION.md.',
        style: 'margin-bottom:6px',
      }),
      legacyText,
      h('div', { class: 'row', style: 'margin-top:6px' }, legacyBtn),
    ),
    out,
    h('div', {
      class: 'footer-note',
      text: `v${chrome.runtime.getManifest().version} · no analytics, no browsing history, no remote code`,
    }),
  );
  return { el };
}
