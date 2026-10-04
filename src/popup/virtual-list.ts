/**
 * Fixed-row-height virtual list with a recycled row pool.
 * DOM size is O(viewport), not O(rows): 50 000 rows cost the same as 20.
 */
export interface Window {
  first: number;
  count: number;
}

export function computeWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = 4,
): Window {
  if (total === 0) return { first: 0, count: 0 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(total - 1, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { first, count: Math.max(0, last - first + 1) };
}

export interface VirtualListOptions<T> {
  rowHeight: number;
  createRow(): HTMLElement;
  /** Fill an existing row element with item `i`. Called only for rows whose content may have changed. */
  bindRow(el: HTMLElement, item: T, index: number): void;
  overscan?: number;
}

export class VirtualList<T> {
  readonly el: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly pool: HTMLElement[] = [];
  private items: readonly T[] = [];
  private raf = 0;
  private dirty = true;
  private firstShown = -1;
  private shown = 0;
  private readonly opts: VirtualListOptions<T>;

  constructor(opts: VirtualListOptions<T>) {
    this.opts = opts;
    this.spacer = document.createElement('div');
    this.spacer.className = 'vl-spacer';
    this.el = document.createElement('div');
    this.el.className = 'vl';
    this.el.append(this.spacer);
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
  }

  /** New data set (filter/sort changed or items mutated). */
  setItems(items: readonly T[], keepScroll = true): void {
    this.items = items;
    this.spacer.style.height = `${items.length * this.opts.rowHeight}px`;
    if (!keepScroll) this.el.scrollTop = 0;
    this.dirty = true;
    this.schedule();
  }

  /** Re-bind visible rows (e.g. after an in-place mutation) without changing the data set. */
  refresh(): void {
    this.dirty = true;
    this.schedule();
  }

  indexOfRow(row: HTMLElement): number {
    return Number(row.dataset.i);
  }

  get length(): number {
    return this.items.length;
  }

  /** Number of row elements currently attached (for tests / benchmarks). */
  get domRows(): number {
    return this.shown;
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  render(): void {
    const { rowHeight, overscan } = this.opts;
    const w = computeWindow(
      this.el.scrollTop,
      this.el.clientHeight || 300,
      rowHeight,
      this.items.length,
      overscan,
    );
    if (!this.dirty && w.first === this.firstShown && w.count === this.shown) return;
    this.dirty = false;
    while (this.pool.length < w.count) {
      const row = this.opts.createRow();
      row.classList.add('vl-row');
      row.style.height = `${rowHeight}px`;
      this.pool.push(row);
      this.el.append(row);
    }
    for (let k = 0; k < this.pool.length; k++) {
      const row = this.pool[k]!;
      if (k >= w.count) {
        if (!row.hidden) row.hidden = true;
        continue;
      }
      const i = w.first + k;
      row.hidden = false;
      row.dataset.i = String(i);
      row.style.transform = `translateY(${i * rowHeight}px)`;
      this.opts.bindRow(row, this.items[i]!, i);
    }
    this.firstShown = w.first;
    this.shown = w.count;
  }
}
