import type { RuntimeState } from '../types/index.ts';

/**
 * Popup -> worker messages. Intentionally tiny: ordinary edits do NOT use messages at all
 * (they write storage and bump the revision; the worker wakes on the storage event).
 */
export type Request = { t: 'sync'; force?: boolean } | { t: 'refresh'; id?: string };

export interface SyncResult {
  /** True when chrome.proxy.settings was actually called. */
  applied: boolean;
  skipped?: 'up-to-date' | 'same-hash';
  hash: string;
  state: RuntimeState;
}

export interface RefreshResult {
  updated: number;
  notModified: number;
  failed: number;
  sync?: SyncResult;
}

export type Response<T> = { ok: true; result: T } | { ok: false; error: string };
