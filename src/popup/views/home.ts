import { formatProxy, parseProxy } from '../../proxy/serialize.ts';
import { newId } from '../../shared/ids.ts';
import type { Mode, PacSource, ProxyServer } from '../../types/index.ts';
import { h, setChildren, setText } from '../dom.ts';
import { collectErrors, describeStatus, ERROR_TITLE } from '../status.ts';
import { repos, saveProxies, saveSettings, store, syncNow } from '../store.ts';
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
      h('dt', { text: 'Status' }),
      h('dd', null, stLabel),
      h('dt', { text: 'Mode' }),
      stMode,
      h('dt', { text: 'Proxies' }),
      stProxies,
      h('dt', { text: 'Rules' }),
      stRules,
      h('dt', { text: 'PAC' }),
      stPac,
    ),
  );

  const hint = h('div', { class: 'small muted', style: 'margin-top:6px' });
  const seg = h('div', { class: 'seg', role: 'group', attrs: { 'aria-label': 'Default mode' } });
  const modeButtons = MODES.map((m) =>
    h('button', {
      type: 'button',
      text: m.label,
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
    attrs: { 'aria-label': 'Proxy address', spellcheck: 'false' },
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

  const el = h(
    'div',
    { class: 'view-enter', style: 'display:flex;flex-direction:column;gap:10px' },
    alerts,
    status,
    h('section', null, h('h3', { text: 'Default for unlisted sites' }), seg, hint),
    h(
      'section',
      null,
      h('h3', { text: 'Proxy servers (failover order)' }),
      proxyList,
      h(
        'div',
        { class: 'row', style: 'margin-top:6px' },
        addInput,
        h('button', { class: 'btn', type: 'button', text: 'Add', on: { click: addProxy } }),
      ),
      addError,
    ),
  );

  // --- granular updates: each function touches only its own DOM -----------------------------
  const renderStatus = () => {
    const { settings, proxies, state, rev } = store.snap;
    const s = describeStatus(settings, proxies, state, rev, pacs);
    setText(stLabel, s.label);
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
          h('b', { text: `${ERROR_TITLE[e.code]}. ` }),
          e.message,
        ),
      ),
    );
  };

  const renderMode = () => {
    const mode = store.snap.settings.mode;
    for (const [i, b] of modeButtons.entries()) b.setAttribute('aria-pressed', String(MODES[i]?.id === mode));
    setText(hint, MODES.find((m) => m.id === mode)?.hint ?? '');
  };

  const renderProxies = () => {
    const list = store.snap.proxies;
    if (list.length === 0) {
      setChildren(proxyList, h('div', { class: 'empty', text: 'No proxy servers yet' }));
      return;
    }
    setChildren(proxyList, ...list.map((p, i) => proxyRow(p, i, list)));
  };

  store.subscribe((_s, changed) => {
    if (changed.has('proxies')) renderProxies();
    if (changed.has('settings')) renderMode();
    renderStatus();
  });
  renderMode();
  renderProxies();
  renderStatus();

  return {
    el,
    onShow() {
      // PAC metadata (names / update times) is not part of the first paint; load it after.
      void repos.pacs.list().then((l) => {
        pacs = l;
        renderStatus();
      });
    },
  };
}

function proxyRow(p: ProxyServer, i: number, all: readonly ProxyServer[]): HTMLElement {
  const save = (next: ProxyServer[]) => void saveProxies(next);
  const toggle = h('input', {
    type: 'checkbox',
    checked: p.enabled,
    attrs: { 'aria-label': `Enable ${formatProxy(p)}` },
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
      title: 'Move up',
      disabled: i === 0,
      on: { click: move(-1) },
    }),
    h('button', {
      class: 'btn icon',
      type: 'button',
      text: '↓',
      title: 'Move down',
      disabled: i === all.length - 1,
      on: { click: move(1) },
    }),
    h('button', {
      class: 'btn icon danger',
      type: 'button',
      text: '✕',
      title: 'Remove',
      on: { click: () => save(all.filter((x) => x.id !== p.id)) },
    }),
  );
}
