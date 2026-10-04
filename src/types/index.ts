/** Shared domain model. Pure data, no behaviour, no chrome.* references. */

export type Action = 'direct' | 'proxy' | 'pac';
export type Mode = 'direct' | 'proxy' | 'pac';
export type ProxyScheme = 'http' | 'https' | 'socks4' | 'socks5';
export type Theme = 'auto' | 'light' | 'dark';

/** `pattern` is already normalised: lowercase ASCII, no trailing dot, optional `*.` prefix. It is the primary key. */
export interface Rule {
  pattern: string;
  action: Action;
  enabled: boolean;
}

export interface ProxyServer {
  id: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  enabled: boolean;
}

export interface FetchMeta {
  lastAttemptAt: number;
  lastSuccessAt: number;
  etag: string;
  lastModified: string;
  /** Hash of the stored body. */
  hash: string;
  bytes: number;
  /** Empty string when the last attempt succeeded. */
  error: string;
}

export interface PacSource {
  id: string;
  name: string;
  kind: 'url' | 'inline';
  url: string;
  enabled: boolean;
  /** 0 = manual refresh only. */
  refreshMinutes: number;
  fetch: FetchMeta;
}

export interface Settings {
  /** Master switch. When false the extension releases proxy control (`proxy.settings.clear`). */
  enabled: boolean;
  /** What happens to hosts that match no rule. */
  mode: Mode;
  /** Append `; DIRECT` to proxy chains so a dead proxy does not black-hole traffic. */
  failoverDirect: boolean;
  /** Plain host names (no dots, e.g. `intranet`) bypass the proxy when no rule matched. */
  bypassLocal: boolean;
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  mode: 'direct',
  failoverDirect: true,
  bypassLocal: true,
  theme: 'auto',
};

export type ErrorCode =
  | 'pac_fetch_failed'
  | 'pac_compile_failed'
  | 'proxy_rejected'
  | 'invalid_proxy'
  | 'invalid_rule'
  | 'controlled_by_other'
  | 'proxy_runtime_error';

export interface AppError {
  code: ErrorCode;
  message: string;
  at: number;
}

/** Runtime state written only by the service worker. Survives worker restarts. */
export interface RuntimeState {
  /** Revision of the configuration that produced `appliedHash`. */
  appliedRev: string;
  appliedHash: string;
  appliedAt: number;
  appliedKind: 'clear' | 'direct' | 'pac';
  pacBytes: number;
  rulesCompiled: number;
  rulesTotal: number;
  proxiesCount: number;
  errors: AppError[];
}

export const EMPTY_STATE: RuntimeState = {
  appliedRev: '',
  appliedHash: '',
  appliedAt: 0,
  appliedKind: 'clear',
  pacBytes: 0,
  rulesCompiled: 0,
  rulesTotal: 0,
  proxiesCount: 0,
  errors: [],
};
