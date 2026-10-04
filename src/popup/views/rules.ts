import { exportRules, parseImport } from '../../domain-rules/import.ts';
import { buildIndex, lookup, type RuleIndex } from '../../domain-rules/matcher.ts';
import { normalizePattern } from '../../domain-rules/normalize.ts';
import type { Action, Rule } from '../../types/index.ts';
import { h, setChildren, setText } from '../dom.ts';
import { download, plural } from '../format.ts';
import { commit, repos } from '../store.ts';
import { VirtualList } from '../virtual-list.ts';
import type { View } from './types.ts';

type SortKey = 'domain' | 'action' | 'state';
const ACTIONS: Action[] = ['direct', 'proxy', 'pac'];
const ROW_H = 28;

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const SORTERS: Record<SortKey, (a: Rule, b: Rule) => number> = {
  domain: (a, b) => cmpStr(a.pattern, b.pattern),
  action: (a, b) => cmpStr(a.action, b.action) || cmpStr(a.pattern, b.pattern),
  state: (a, b) => Number(b.enabled) - Number(a.enabled) || cmpStr(a.pattern, b.pattern),
};

export function createRulesView(): View {
  let all: Rule[] = [];
  let byPattern = new Map<string, Rule>();
  let shown: Rule[] = [];
  const selected = new Set<string>();
  let query = '';
  let sortKey: SortKey = 'domain';
  let index: RuleIndex | undefined; // lazily built for "test host", invalidated on every mutation
  let loaded = false;

  // ---- rows ---------------------------------------------------------------------------------
  const list = new VirtualList<Rule>({
    rowHeight: ROW_H,
    createRow() {
      const sel = h('input', { type: 'checkbox', class: 'sel', attrs: { 'aria-label': 'Select rule' } });
      const dom = h('span', { class: 'domain' });
      const act = h(
        'select',
        { class: 'act', attrs: { 'aria-label': 'Action' } },
        ...ACTIONS.map((a) => h('option', { value: a, text: a.toUpperCase() })),
      );
      const en = h('input', { type: 'checkbox', class: 'en', attrs: { 'aria-label': 'Enabled' } });
      return h(
        'div',
        null,
        sel,
        dom,
        act,
        h('label', { class: 'switch sm' }, en, h('span', { class: 'track' })),
      );
    },
    bindRow(row, rule) {
      const [sel, dom, act, sw] = row.children as unknown as [
        HTMLInputElement,
        HTMLElement,
        HTMLSelectElement,
        HTMLElement,
      ];
      const en = sw.firstElementChild as HTMLInputElement;
      if (dom.textContent !== rule.pattern) {
        dom.textContent = rule.pattern;
        dom.title = rule.pattern;
      }
      const isSel = selected.has(rule.pattern);
      if (sel.checked !== isSel) sel.checked = isSel;
      if (act.value !== rule.action) act.value = rule.action;
      if (en.checked !== rule.enabled) en.checked = rule.enabled;
      row.classList.toggle('off', !rule.enabled);
    },
  });
  const empty = h('div', { class: 'vl-empty', text: 'Loading…' });

  // ---- model --------------------------------------------------------------------------------
  const refilter = (keepScroll = true) => {
    const q = query.trim().toLowerCase();
    if (q === '') shown = all;
    else {
      const out: Rule[] = [];
      for (let i = 0; i < all.length; i++) if (all[i]!.pattern.includes(q)) out.push(all[i]!);
      shown = out;
    }
    list.setItems(shown, keepScroll);
    empty.hidden = shown.length > 0;
    setText(
      empty,
      loaded
        ? all.length === 0
          ? 'No rules yet. Add one or import a list.'
          : 'Nothing matches.'
        : 'Loading…',
    );
    setText(count, query ? `${shown.length} of ${all.length}` : plural(all.length, 'rule'));
    updateBulk();
  };

  const resort = () => {
    all.sort(SORTERS[sortKey]);
    refilter();
  };

  /** In-place edits: no re-sort, no re-filter; only the visible rows are re-bound. */
  const mutate = async (patterns: readonly string[], patch: Partial<Pick<Rule, 'action' | 'enabled'>>) => {
    const changed: Rule[] = [];
    for (const p of patterns) {
      const r = byPattern.get(p);
      if (!r) continue;
      Object.assign(r, patch);
      changed.push(r);
    }
    index = undefined;
    list.refresh();
    await repos.rules.putMany(changed);
    await commit();
  };

  const remove = async (patterns: readonly string[]) => {
    const gone = new Set(patterns);
    all = all.filter((r) => !gone.has(r.pattern));
    for (const p of patterns) {
      byPattern.delete(p);
      selected.delete(p);
    }
    index = undefined;
    refilter();
    await repos.rules.deleteMany(patterns);
    await commit();
  };

  const upsert = async (incoming: readonly Rule[]) => {
    for (const r of incoming) {
      const cur = byPattern.get(r.pattern);
      if (cur) Object.assign(cur, r);
      else {
        const copy = { ...r };
        byPattern.set(copy.pattern, copy);
        all.push(copy);
      }
    }
    index = undefined;
    resort();
    await repos.rules.putMany(incoming); // ONE transaction regardless of size
    await commit();
  };

  // ---- toolbar ------------------------------------------------------------------------------
  const count = h('span', { class: 'muted small' });
  const search = h('input', {
    type: 'search',
    placeholder: 'Search domains…',
    attrs: { 'aria-label': 'Search rules', spellcheck: 'false' },
  });
  let raf = 0;
  search.addEventListener('input', () => {
    // Coalesce to one filter per frame instead of a timer: the filter is cheap (see docs/PERFORMANCE.md).
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      query = search.value;
      refilter(false);
    });
  });

  const addInput = h('input', {
    type: 'text',
    class: 'grow mono',
    placeholder: 'example.com or *.example.com',
    attrs: { 'aria-label': 'New rule', spellcheck: 'false' },
  });
  const addAction = h(
    'select',
    { attrs: { 'aria-label': 'Action for new rule' } },
    ...ACTIONS.map((a) => h('option', { value: a, text: a.toUpperCase(), selected: a === 'proxy' })),
  );
  const addErr = h('div', { class: 'small', style: 'color:var(--err)' });
  const add = () => {
    const n = normalizePattern(addInput.value);
    if (!n.ok) return setText(addErr, `Invalid domain: ${n.error}`);
    setText(addErr, '');
    addInput.value = '';
    void upsert([{ pattern: n.pattern, action: addAction.value as Action, enabled: true }]).then(() => {
      search.value = n.pattern;
      query = n.pattern;
      refilter(false);
    });
  };
  addInput.addEventListener('keydown', (e) => e.key === 'Enter' && add());

  // bulk bar
  const bulkInfo = h('span', { class: 'small' });
  const bulkAct = h(
    'select',
    { attrs: { 'aria-label': 'Bulk action' } },
    h('option', { value: '', text: 'Set action…' }),
    ...ACTIONS.map((a) => h('option', { value: a, text: a.toUpperCase() })),
  );
  bulkAct.addEventListener('change', () => {
    if (bulkAct.value) void mutate([...selected], { action: bulkAct.value as Action });
    bulkAct.value = '';
  });
  let armed = false;
  const bulkDel = h('button', { class: 'btn danger', type: 'button', text: 'Delete' });
  bulkDel.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      bulkDel.textContent = `Delete ${selected.size}?`;
      bulkDel.classList.add('armed');
      setTimeout(() => {
        armed = false;
        bulkDel.classList.remove('armed');
        bulkDel.textContent = 'Delete';
      }, 2500);
      return;
    }
    armed = false;
    bulkDel.classList.remove('armed');
    bulkDel.textContent = 'Delete';
    void remove([...selected]);
  });
  const bulk = h(
    'div',
    { class: 'bulk', hidden: true },
    bulkInfo,
    h('button', {
      class: 'btn',
      type: 'button',
      text: 'Enable',
      on: { click: () => void mutate([...selected], { enabled: true }) },
    }),
    h('button', {
      class: 'btn',
      type: 'button',
      text: 'Disable',
      on: { click: () => void mutate([...selected], { enabled: false }) },
    }),
    bulkAct,
    bulkDel,
  );
  function updateBulk() {
    bulk.hidden = selected.size === 0;
    setText(bulkInfo, `${selected.size} selected`);
    selAll.checked =
      shown.length > 0 && selected.size >= shown.length && shown.every((r) => selected.has(r.pattern));
  }

  const selAll = h('input', { type: 'checkbox', attrs: { 'aria-label': 'Select all shown' } });
  selAll.addEventListener('change', () => {
    if (selAll.checked) for (const r of shown) selected.add(r.pattern);
    else for (const r of shown) selected.delete(r.pattern);
    list.refresh();
    updateBulk();
  });

  const sortBtn = (key: SortKey, label: string) =>
    h('button', {
      type: 'button',
      text: label,
      title: `Sort by ${label.toLowerCase()}`,
      on: {
        click: () => {
          sortKey = key;
          resort();
        },
      },
    });

  // row events (one delegated listener for the whole list)
  list.el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const row = t.closest<HTMLElement>('.vl-row');
    if (!row) return;
    const rule = shown[list.indexOfRow(row)];
    if (!rule) return;
    if (t.classList.contains('sel')) {
      if ((t as HTMLInputElement).checked) selected.add(rule.pattern);
      else selected.delete(rule.pattern);
      updateBulk();
    } else if (t.classList.contains('act')) void mutate([rule.pattern], { action: t.value as Action });
    else if (t.classList.contains('en'))
      void mutate([rule.pattern], { enabled: (t as HTMLInputElement).checked });
  });

  // ---- import / export / test ---------------------------------------------------------------
  const panel = h('div');
  const openImport = () => {
    let text = '';
    const area = h('textarea', {
      rows: 6,
      placeholder: 'google.com\nyoutube.com PROXY\n*.example.org DIRECT\n# comments are ignored',
      attrs: { 'aria-label': 'Rules to import', spellcheck: 'false' },
    });
    area.addEventListener('input', () => {
      text = area.value;
      if (text.length > 20_000) {
        // A textarea holding thousands of lines is expensive to lay out; keep the text in memory instead.
        area.value = '';
        area.placeholder = `${(text.length / 1024).toFixed(0)} KB pasted. Press Preview.`;
      }
      setChildren(result);
    });
    const file = h('input', {
      type: 'file',
      accept: '.txt,.list,text/plain',
      attrs: { 'aria-label': 'Import from file' },
    });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      text = await f.text();
      area.value = '';
      area.placeholder = `${f.name} loaded (${(f.size / 1024).toFixed(0)} KB). Press Preview.`;
      setChildren(result);
    });
    const def = h(
      'select',
      { attrs: { 'aria-label': 'Default action' } },
      ...ACTIONS.map((a) => h('option', { value: a, text: a.toUpperCase(), selected: a === 'proxy' })),
    );
    const result = h('div', { class: 'small', style: 'margin:6px 0' });
    const preview = h('button', { class: 'btn', type: 'button', text: 'Preview' });
    preview.addEventListener('click', async () => {
      setText(result, 'Parsing…');
      await new Promise((r) => requestAnimationFrame(r)); // let "Parsing…" paint before the synchronous parse
      const parsed = parseImport(text, def.value as Action);
      const newCount = parsed.rules.reduce((n, r) => n + (byPattern.has(r.pattern) ? 0 : 1), 0);
      const go = h('button', {
        class: 'btn primary',
        type: 'button',
        text: `Import ${parsed.rules.length.toLocaleString()}`,
        disabled: parsed.rules.length === 0,
      });
      go.addEventListener('click', async () => {
        go.disabled = true;
        setText(go, 'Saving…');
        await upsert(parsed.rules);
        panel.replaceChildren();
      });
      setChildren(
        result,
        h(
          'div',
          null,
          `${plural(parsed.rules.length, 'rule')} (${newCount.toLocaleString()} new, ${(parsed.rules.length - newCount).toLocaleString()} overwrite)`,
          parsed.duplicates ? ` · ${plural(parsed.duplicates, 'duplicate')}` : '',
          parsed.invalid ? ` · ${parsed.invalid.toLocaleString()} invalid` : '',
        ),
        parsed.issues.length > 0 &&
          h(
            'div',
            { class: 'alert warn', style: 'margin:4px 0;max-height:70px;overflow:auto' },
            ...parsed.issues
              .slice(0, 5)
              .map((i) => h('div', { text: `line ${i.line}: ${i.error} — ${i.text}` })),
          ),
        go,
      );
    });
    setChildren(
      panel,
      h(
        'div',
        { class: 'card view-enter', style: 'margin-bottom:8px' },
        h('h3', { text: 'Import rules' }),
        area,
        h('div', { class: 'row', style: 'margin-top:6px' }, file),
        h(
          'div',
          { class: 'row', style: 'margin-top:6px' },
          h('span', { class: 'small muted', text: 'Default action' }),
          def,
          preview,
          h('button', {
            class: 'btn',
            type: 'button',
            text: 'Close',
            on: { click: () => panel.replaceChildren() },
          }),
        ),
        result,
      ),
    );
  };

  const testInput = h('input', {
    type: 'text',
    class: 'mono',
    placeholder: 'test host: mail.example.com',
    attrs: { 'aria-label': 'Test a host', spellcheck: 'false' },
  });
  const testOut = h('div', { class: 'small muted' });
  testInput.addEventListener('input', () => {
    const n = normalizePattern(testInput.value);
    if (!n.ok || n.pattern.startsWith('*'))
      return setText(testOut, testInput.value ? 'Enter a host name' : '');
    index ??= buildIndex(all);
    const hit = lookup(index, n.pattern);
    setText(
      testOut,
      hit ? `→ ${hit.action.toUpperCase()} via ${hit.via}` : '→ no rule: default mode applies',
    );
  });

  const el = h(
    'div',
    { class: 'rules-wrap view-enter' },
    h(
      'div',
      { class: 'toolbar' },
      search,
      h('button', { class: 'btn', type: 'button', text: 'Import', on: { click: openImport } }),
      h('button', {
        class: 'btn',
        type: 'button',
        text: 'Export',
        on: { click: () => download('rules.txt', exportRules(all)) },
      }),
    ),
    h(
      'div',
      { class: 'row', style: 'margin:6px 0' },
      addInput,
      addAction,
      h('button', { class: 'btn primary', type: 'button', text: 'Add', on: { click: add } }),
    ),
    addErr,
    panel,
    h('div', { class: 'row between', style: 'margin-bottom:4px' }, count, bulk),
    h(
      'div',
      { class: 'table-head' },
      selAll,
      sortBtn('domain', 'Domain'),
      sortBtn('action', 'Action'),
      sortBtn('state', 'On'),
    ),
    h(
      'div',
      { style: 'position:relative;flex:1;min-height:0;display:flex;flex-direction:column' },
      list.el,
      empty,
    ),
    h('div', { class: 'row', style: 'margin-top:6px' }, testInput, testOut),
  );

  return {
    el,
    onShow() {
      if (loaded) return list.render();
      void repos.rules.getAll().then((rules) => {
        loaded = true;
        all = rules;
        byPattern = new Map(rules.map((r) => [r.pattern, r]));
        resort();
      });
    },
  };
}
