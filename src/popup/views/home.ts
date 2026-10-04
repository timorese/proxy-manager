import { formatProxy, parseProxy } from '../../proxy/serialize.ts';
import { newId } from '../../shared/ids.ts';
import type { Action, Mode, PacSource, ProxyServer, Rule } from '../../types/index.ts';
import { h, setChildren, setText } from '../dom.ts';
import { t } from '../i18n.ts';
import {
  candidatePatterns,
  describeVia,
  explainRoute,
  hostOfUrl,
  patternForSite,
  type Route,
} from '../route.ts';
import { collectErrors, describeStatus, ERROR_TITLE } from '../status.ts';
import { commit, repos, rulesState, saveProxies, saveSettings, store, syncNow } from '../store.ts';
import type { View } from './types.ts';

const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: 'direct',
    label: 'Direct',
    hint: 'Unlisted sites go direct. Only rules send traffic through the proxy.',
  },
  { id: 'proxy', label: 'Proxy', hint: 'Unlisted sites use your proxies. Rules can force DIRECT.' },
  { id: 'pac', label: 'PAC', hint: 'Unlisted sites are decided by your enabled PAC sources.' },
];

export function createHomeView(): View {
  let pacs: PacSource[] | undefined;

  const alerts = h('div', { class: 'alerts', attrs: { 'aria-live': 'polite' } });
  const stLabel = h('span', { class: 'badge' });
  const stMode = h('dd');
  const stProxies = h('dd', { class: 'mono' });
  const stRules = h('dd');
  const stPac = h('dd');
  const status = h(
    'div',
    { class: 'card' },
    h(
      'dl',
      { class: 'status', style: 'margin:0' },
      h('dt', { text: t('Status') }),
      h('dd', null, stLabel),
      h('dt', { text: t('Mode') }),
      stMode,
      h('dt', { text: t('Proxies') }),
      stProxies,
      h('dt', { text: t('Rules') }),
      stRules,
      h('dt', { text: 'PAC' }),
      stPac,
    ),
  );

  const hint = h('div', { class: 'small muted', style: 'margin-top:6px' });
  const seg = h('div', { class: 'seg', role: 'group', attrs: { 'aria-label': t('Default mode') } });
  const modeButtons = MODES.map((m) =>
    h('button', {
      type: 'button',
      text: t(m.label),
      attrs: { 'aria-pressed': 'false' },
      on: {
        click: () => {
          if (store.snap.settings.mode === m.id) return;
          void saveSettings({ mode: m.id }).then(() => syncNow());
        },
      },
    }),
  );
  seg.append(...modeButtons);

  const proxyList = h('div', { class: 'list' });
  const addInput = h('input', {
    type: 'text',
    class: 'grow mono',
    placeholder: 'socks5://127.0.0.1:1080',
    attrs: { 'aria-label': t('Proxy address'), spellcheck: 'false' },
  });
  const addError = h('div', { class: 'small', style: 'color:var(--err)' });
  const addProxy = () => {
    const parsed = parseProxy(addInput.value);
    if (!parsed.ok) {
      setText(addError, parsed.error);
      return;
    }
    setText(addError, '');
    addInput.value = '';
    void saveProxies([
      ...store.snap.proxies,
      { id: newId(), scheme: parsed.scheme, host: parsed.host, port: parsed.port, enabled: true },
    ]);
  };
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addProxy();
  });

  // ---- current site: which route applies, and one-click "add to list" ------------------------
  let siteHost = '';
  let siteRules: Rule[] = [];
  const siteName = h('b', { class: 'mono ellipsis' });
  const siteRoute = h('span', { class: 'badge' });
  const siteVia = h('div', { class: 'small muted' });
  const subCheck = h('input', {
    type: 'checkbox',
    checked: true,
    attrs: { 'aria-label': t('Include subdomains') },
  });
  const ACTION_LABEL: Record<Action, string> = { proxy: 'Proxy', direct: 'Direct', pac: 'PAC' };
  const addButtons = (['proxy', 'direct', 'pac'] as Action[]).map((a) =>
    h('button', {
      class: 'btn',
      type: 'button',
      text: t(ACTION_LABEL[a]),
      attrs: { 'data-action': a },
      on: { click: () => void addSite(a) },
    }),
  );
  const siteAddRow = h(
    'div',
    { class: 'row', style: 'margin-top:8px;flex-wrap:wrap' },
    h('span', { class: 'small muted', text: t('Add to list:') }),
    ...addButtons,
    h('label', { class: 'row small', style: 'gap:4px' }, subCheck, t('subdomains')),
  );
  const siteCard = h(
    'div',
    { class: 'card', hidden: true },
    h('h3', { text: t('Current site') }),
    h('div', { class: 'row between' }, siteName, siteRoute),
    siteVia,
    siteAddRow,
  );

  const currentRoute = (): Route =>
    explainRoute(
      siteHost,
      store.snap.settings,
      { proxies: store.snap.proxies.some((p) => p.enabled), pacs: (pacs ?? []).some((p) => p.enabled) },
      siteRules,
    );

  const renderSite = () => {
    if (!siteHost) return;
    siteCard.hidden = false;
    const r = currentRoute();
    setText(siteName, siteHost);
    setText(siteRoute, t(r.action.toUpperCase()));
    siteRoute.className = `badge ${r.action === 'direct' ? '' : r.action === 'proxy' ? 'ok' : 'warn'}`;
    setText(
      siteVia,
      [
        describeVia(r, store.snap.settings.mode),
        r.kind === 'rule' || r.kind === 'default' ? (r.note ? t(r.note) : '') : '',
      ]
        .filter(Boolean)
        .join(' · '),
    );
    const pattern = patternForSite(siteHost, subCheck.checked);
    const existing = siteRules.find((x) => x.pattern === pattern);
    for (const b of addButtons)
      b.setAttribute(
        'aria-pressed',
        String(Boolean(existing?.enabled) && existing?.action === b.dataset.action),
      );
  };
  subCheck.addEventListener('change', renderSite);

  const loadSiteRules = async () => {
    siteRules = (await repos.rules.getMany(candidatePatterns(siteHost))).filter((r) => r.enabled);
    renderSite();
  };

  async function addSite(action: Action): Promise<void> {
    const pattern = patternForSite(siteHost, subCheck.checked);
    await repos.rules.putMany([{ pattern, action, enabled: true }]);
    rulesState.dirty = true;
    await commit();
    await loadSiteRules();
  }

  const initSite = async () => {
    // `?site=host` lets automated tests exercise this card; real use reads the active tab (permission: activeTab).
    const override = new URLSearchParams(location.search).get('site');
    if (override) siteHost = override;
    else {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        siteHost = hostOfUrl(tab?.url);
      } catch {
        siteHost = '';
      }
    }
    if (siteHost) await loadSiteRules();
  };

  const el = h(
    'div',
    { class: 'view-enter', style: 'display:flex;flex-direction:column;gap:10px' },
    alerts,
    status,
    siteCard,
    h('section', null, h('h3', { text: t('Default for unlisted sites') }), seg, hint),
    h(
      'section',
      null,
      h('h3', { text: t('Proxy servers (failover order)') }),
      proxyList,
      h(
        'div',
        { class: 'row', style: 'margin-top:6px' },
        addInput,
        h('button', { class: 'btn', type: 'button', text: t('Add'), on: { click: addProxy } }),
      ),
      addError,
    ),
  );

  // --- granular updates: each function touches only its own DOM -----------------------------
  const renderStatus = () => {
    const { settings, proxies, state, rev } = store.snap;
    const s = describeStatus(settings, proxies, state, rev, pacs);
    setText(stLabel, t(s.label));
    stLabel.className = `badge ${s.tone}`;
    setText(stMode, s.modeText);
    setText(stProxies, s.proxies.length ? s.proxies.join('\n') : '—');
    stProxies.style.whiteSpace = 'pre-line';
    setText(stRules, String(s.rules));
    setText(stPac, s.pac);
    const errors = collectErrors(state, pacs);
    setChildren(
      alerts,
      ...errors.map((e) =>
        h(
          'div',
          {
            class: e.code === 'proxy_rejected' || e.code === 'controlled_by_other' ? 'alert' : 'alert warn',
            style: 'margin-bottom:6px',
          },
          h('b', { text: `${t(ERROR_TITLE[e.code])}. ` }),
          e.message,
        ),
      ),
    );
  };

  const renderMode = () => {
    const mode = store.snap.settings.mode;
    for (const [i, b] of modeButtons.entries()) b.setAttribute('aria-pressed', String(MODES[i]?.id === mode));
    setText(hint, t(MODES.find((m) => m.id === mode)?.hint ?? ''));
  };

  const renderProxies = () => {
    const list = store.snap.proxies;
    if (list.length === 0) {
      setChildren(proxyList, h('div', { class: 'empty', text: t('No proxy servers yet') }));
      return;
    }
    setChildren(proxyList, ...list.map((p, i) => proxyRow(p, i, list)));
  };

  store.subscribe((_s, changed) => {
    if (changed.has('proxies')) renderProxies();
    if (changed.has('settings')) renderMode();
    renderStatus();
    renderSite();
  });
  renderMode();
  renderProxies();
  renderStatus();

  void initSite();

  return {
    el,
    onShow() {
      // PAC metadata (names / update times) is not part of the first paint; load it after.
      void repos.pacs.list().then((l) => {
        pacs = l;
        renderStatus();
        renderSite();
      });
    },
  };
}

function proxyRow(p: ProxyServer, i: number, all: readonly ProxyServer[]): HTMLElement {
  const save = (next: ProxyServer[]) => void saveProxies(next);
  const toggle = h('input', {
    type: 'checkbox',
    checked: p.enabled,
    attrs: { 'aria-label': t('Enable {x}', { x: formatProxy(p) }) },
    on: { change: () => save(all.map((x) => (x.id === p.id ? { ...x, enabled: toggle.checked } : x))) },
  });
  const move = (d: number) => () => {
    const next = [...all];
    const [m] = next.splice(i, 1);
    next.splice(i + d, 0, m!);
    save(next);
  };
  return h(
    'div',
    { class: 'item' },
    toggle,
    h('span', { class: 'grow mono ellipsis', text: formatProxy(p), title: formatProxy(p) }),
    h('button', {
      class: 'btn icon',
      type: 'button',
      text: '↑',
      title: t('Move up'),
      disabled: i === 0,
      on: { click: move(-1) },
    }),
    h('button', {
      class: 'btn icon',
      type: 'button',
      text: '↓',
      title: t('Move down'),
      disabled: i === all.length - 1,
      on: { click: move(1) },
    }),
    h('button', {
      class: 'btn icon danger',
      type: 'button',
      text: '✕',
      title: t('Remove'),
      on: { click: () => save(all.filter((x) => x.id !== p.id)) },
    }),
  );
}
