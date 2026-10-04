export type Child = Node | string | number | false | null | undefined;

type Props = {
  class?: string;
  text?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
  [prop: string]: unknown;
};

/** Minimal element factory. No virtual DOM: callers update the nodes they own. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v === undefined || v === null) continue;
      if (k === 'class') el.className = v as string;
      else if (k === 'text') el.textContent = v as string;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'attrs')
        for (const a in v as object) el.setAttribute(a, (v as Record<string, string>)[a]!);
      else if (k === 'on')
        for (const ev in v as object) el.addEventListener(ev, (v as Record<string, EventListener>)[ev]!);
      else (el as unknown as Record<string, unknown>)[k] = v;
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

/** Replace all children in one operation. */
export const setChildren = (el: Element, ...children: Child[]): void => {
  el.replaceChildren();
  append(el, children);
};

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

/** Assign only when different: avoids needless style/layout invalidation. */
export const setText = (el: Node, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};
