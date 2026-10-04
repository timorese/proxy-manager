import { validatePacSource } from '../../pac/pac-source.ts';
import { hashString } from '../../shared/hash.ts';
import { newId } from '../../shared/ids.ts';
import type { PacSource } from '../../types/index.ts';
import { h, setChildren, setText } from '../dom.ts';
import { ago, fmtBytes } from '../format.ts';
import { commit, refreshPac, repos, store, syncNow } from '../store.ts';
import type { View } from './types.ts';

const REFRESH_CHOICES = [
  { v: 0, t: 'Manual only' },
  { v: 15, t: 'Every 15 min' },
  { v: 60, t: 'Every hour' },
  { v: 360, t: 'Every 6 hours' },
  { v: 1440, t: 'Every day' },
];

const emptyMeta = () => ({
  lastAttemptAt: 0,
  lastSuccessAt: 0,
  etag: '',
  lastModified: '',
  hash: '',
  bytes: 0,
  error: '',
});

export function createPacsView(): View {
  let sources: PacSource[] = [];
  const listEl = h('div', { class: 'list' });
  const formHost = h('div');
  const msg = h('div', { class: 'small muted', attrs: { 'aria-live': 'polite' } });

  const load = async () => {
    sources = (await repos.pacs.list()).sort((a, b) => a.name.localeCompare(b.name));
    renderList();
  };

  /** After any change: ONE revision bump, then a direct sync so the result is visible immediately. */
  const changed = async () => {
    await commit();
    void syncNow().catch(() => {});
    await load();
  };

  const statusOf = (s: PacSource): [string, string] => {
    if (s.kind === 'inline') return ['inline', ''];
    if (s.fetch.error) return [`failed: ${s.fetch.error}`, 'err'];
    if (!s.fetch.lastSuccessAt) return ['not downloaded', 'warn'];
    return ['ok', 'ok'];
  };

  const renderList = () => {
    if (sources.length === 0) {
      setChildren(listEl, h('div', { class: 'empty', text: 'No PAC sources. Add a URL or paste a script.' }));
      return;
    }
    setChildren(listEl, ...sources.map(row));
  };

  const row = (s: PacSource): HTMLElement => {
    const [statusText, tone] = statusOf(s);
    const toggle = h('input', {
      type: 'checkbox',
      checked: s.enabled,
      attrs: { 'aria-label': `Enable ${s.name}` },
      on: {
        change: () => {
          void repos.pacs.put({ ...s, enabled: toggle.checked }).then(changed);
        },
      },
    });
    let armed = false;
    const del = h('button', {
      class: 'btn danger',
      type: 'button',
      text: 'Delete',
      on: {
        click: () => {
          if (!armed) {
            armed = true;
            del.textContent = 'Sure?';
            del.classList.add('armed');
            setTimeout(() => {
              armed = false;
              del.textContent = 'Delete';
              del.classList.remove('armed');
            }, 2500);
            return;
          }
          void repos.pacs.delete(s.id).then(changed);
        },
      },
    });
    const update = h('button', {
      class: 'btn',
      type: 'button',
      text: 'Update',
      disabled: s.kind !== 'url',
      title: s.kind === 'url' ? 'Download now' : 'Inline scripts have nothing to download',
      on: {
        click: async () => {
          update.disabled = true;
          setText(update, '…');
          try {
            const r = await refreshPac(s.id);
            setText(
              msg,
              r.failed
                ? 'Update failed (kept the previous version).'
                : r.updated
                  ? 'Updated.'
                  : 'Already up to date.',
            );
          } catch (e) {
            setText(msg, e instanceof Error ? e.message : String(e));
          }
          await load();
        },
      },
    });
    return h(
      'div',
      { class: 'item', style: 'align-items:flex-start;flex-wrap:wrap' },
      toggle,
      h(
        'div',
        { class: 'grow' },
        h(
          'div',
          { class: 'row between' },
          h('b', { class: 'ellipsis', text: s.name }),
          h('span', { class: `badge ${tone}`, text: statusText, title: statusText }),
        ),
        h('div', {
          class: 'small muted ellipsis mono',
          text: s.kind === 'url' ? s.url : `Inline script · ${fmtBytes(s.fetch.bytes)}`,
          title: s.url,
        }),
        h('div', {
          class: 'small muted',
          text:
            s.kind === 'url'
              ? `Updated ${ago(s.fetch.lastSuccessAt)} · ${REFRESH_CHOICES.find((c) => c.v === s.refreshMinutes)?.t ?? `${s.refreshMinutes} min`}`
              : `Saved ${ago(s.fetch.lastSuccessAt)}`,
        }),
        h(
          'div',
          { class: 'row', style: 'margin-top:4px' },
          update,
          h('button', { class: 'btn', type: 'button', text: 'Edit', on: { click: () => void openForm(s) } }),
          del,
        ),
      ),
    );
  };

  const openForm = async (existing?: PacSource) => {
    const name = h('input', {
      type: 'text',
      value: existing?.name ?? '',
      placeholder: 'Corporate PAC',
      attrs: { 'aria-label': 'Name' },
    });
    const kind = h(
      'select',
      null,
      h('option', { value: 'url', text: 'URL' }),
      h('option', { value: 'inline', text: 'Inline script' }),
    );
    kind.value = existing?.kind ?? 'url';
    const url = h('input', {
      type: 'url',
      value: existing?.url ?? '',
      placeholder: 'https://example.com/proxy.pac',
      class: 'mono',
      attrs: { 'aria-label': 'PAC URL', spellcheck: 'false' },
    });
    const refresh = h(
      'select',
      null,
      ...REFRESH_CHOICES.map((c) => h('option', { value: String(c.v), text: c.t })),
    );
    refresh.value = String(existing?.refreshMinutes ?? 0);
    const body = h('textarea', {
      rows: 8,
      placeholder: 'function FindProxyForURL(url, host) {\n  return "DIRECT";\n}',
      attrs: { 'aria-label': 'PAC script', spellcheck: 'false' },
    });
    if (existing?.kind === 'inline') body.value = (await repos.pacs.getBody(existing.id)) ?? '';
    const err = h('div', {
      class: 'small',
      style: 'color:var(--err);margin-bottom:6px',
      attrs: { role: 'alert' },
    });
    const urlField = h(
      'div',
      { class: 'field' },
      h('span', { class: 'lbl', text: 'URL' }),
      url,
      h('span', { class: 'lbl', text: 'Refresh' }),
      refresh,
    );
    const bodyField = h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Script' }), body);
    const sync = () => {
      urlField.hidden = kind.value !== 'url';
      bodyField.hidden = kind.value !== 'inline';
    };
    kind.addEventListener('change', sync);
    sync();

    const save = h('button', { class: 'btn primary', type: 'button', text: 'Save' });
    save.addEventListener('click', () => {
      setText(err, '');
      const isUrl = kind.value === 'url';
      const trimmed = name.value.trim();
      if (!trimmed) return setText(err, 'Name is required.');
      let origin = '';
      if (isUrl) {
        try {
          const u = new URL(url.value.trim());
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
          origin = `${u.origin}/*`;
        } catch {
          return setText(err, 'Enter a valid http(s) URL.');
        }
      } else {
        const check = validatePacSource(body.value);
        if (!check.ok) return setText(err, `Invalid script: ${check.reason}`);
      }
      // permissions.request needs the user gesture, so it must be called synchronously from the click handler.
      // It is NOT awaited before saving: the prompt may stay open for a long time (or never resolve in automation).
      const permission = isUrl
        ? chrome.permissions.request({ origins: [origin] }).catch(() => false)
        : Promise.resolve(true);
      save.disabled = true;
      void (async () => {
        const id = existing?.id ?? newId();
        const urlChanged = isUrl && existing?.url !== url.value.trim();
        const base: PacSource = {
          id,
          name: trimmed,
          kind: isUrl ? 'url' : 'inline',
          url: isUrl ? url.value.trim() : '',
          enabled: existing?.enabled ?? true,
          refreshMinutes: isUrl ? Number(refresh.value) : 0,
          fetch: existing && !urlChanged && isUrl ? existing.fetch : emptyMeta(),
        };
        if (isUrl) {
          // A new/changed URL has no known-good body yet (empty body + empty metadata); an unchanged one keeps both.
          if (!existing || urlChanged) await repos.pacs.put(base, '');
          else await repos.pacs.put(base);
          formHost.replaceChildren();
          await commit();
          await load();
          // Try right away (works when the server sends CORS headers), and once more if the user grants the origin later.
          void permission.then((granted) => {
            if (granted) void refreshPac(id).then(load, () => {});
          });
          setText(msg, 'Downloading…');
          try {
            const r = await refreshPac(id);
            setText(msg, r.failed ? 'Download failed. See the status badge.' : 'Downloaded.');
          } catch (e) {
            setText(msg, e instanceof Error ? e.message : String(e));
          }
          await load();
        } else {
          const text = body.value;
          await repos.pacs.put(
            {
              ...base,
              fetch: {
                ...emptyMeta(),
                lastSuccessAt: Date.now(),
                lastAttemptAt: Date.now(),
                hash: await hashString(text),
                bytes: text.length,
              },
            },
            text,
          );
          formHost.replaceChildren();
          await changed();
        }
      })();
    });
    const cancel = h('button', {
      class: 'btn',
      type: 'button',
      text: 'Cancel',
      on: { click: () => formHost.replaceChildren() },
    });
    setChildren(
      formHost,
      h(
        'div',
        { class: 'card form view-enter' },
        h('h3', { text: existing ? 'Edit PAC source' : 'Add PAC source' }),
        h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Name' }), name),
        h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Type' }), kind),
        urlField,
        bodyField,
        err,
        h('div', { class: 'row' }, save, cancel),
      ),
    );
    name.focus();
  };

  const el = h(
    'div',
    { class: 'view-enter', style: 'display:flex;flex-direction:column;gap:10px' },
    h(
      'div',
      { class: 'row between' },
      h('h3', { text: 'PAC sources', style: 'margin:0' }),
      h('button', {
        class: 'btn primary',
        type: 'button',
        text: '+ Add',
        on: { click: () => void openForm() },
      }),
    ),
    h('div', {
      class: 'small muted',
      text: 'Enabled sources are combined in this order: the first one that answers with something other than DIRECT wins. Scripts are embedded as data in the PAC given to Chrome; they never run inside the extension.',
    }),
    formHost,
    listEl,
    msg,
  );

  store.subscribe((_s, c) => {
    if (c.has('state')) void load(); // a refresh / sync changed fetch metadata
  });
  return { el, onShow: () => void load() };
}
