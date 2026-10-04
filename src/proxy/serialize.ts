import { checkHost } from '../domain-rules/normalize.ts';
import type { ProxyScheme, ProxyServer } from '../types/index.ts';

const PAC_KEYWORD: Record<ProxyScheme, string> = {
  http: 'PROXY',
  https: 'HTTPS',
  socks4: 'SOCKS4',
  socks5: 'SOCKS5',
};
export const DEFAULT_PORT: Record<ProxyScheme, number> = { http: 80, https: 443, socks4: 1080, socks5: 1080 };
export const SCHEMES = Object.keys(PAC_KEYWORD) as ProxyScheme[];

const isIPv6Literal = (h: string): boolean =>
  h.length > 2 && h.charCodeAt(0) === 91 && h.endsWith(']') && /^\[[0-9a-f:.]+\]$/i.test(h);

/** `{ok:false}` for anything that could break the generated PAC string. */
export function validateProxy(p: Pick<ProxyServer, 'scheme' | 'host' | 'port'>): string {
  if (!(p.scheme in PAC_KEYWORD)) return 'unknown scheme';
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) return 'port must be 1-65535';
  const host = p.host.toLowerCase();
  if (isIPv6Literal(host)) return '';
  const err = checkHost(host);
  return err ? `invalid host: ${err}` : '';
}

export function serializeProxy(p: Pick<ProxyServer, 'scheme' | 'host' | 'port'>): string {
  return `${PAC_KEYWORD[p.scheme]} ${p.host.toLowerCase()}:${p.port}`;
}

/** `SOCKS5 a:1; SOCKS5 b:1080; DIRECT`. Order is the user's failover order. */
export function serializeChain(proxies: readonly ProxyServer[], failoverDirect: boolean): string {
  const parts: string[] = [];
  for (const p of proxies) parts.push(serializeProxy(p));
  if (failoverDirect || parts.length === 0) parts.push('DIRECT');
  return parts.join('; ');
}

export type ParsedProxy =
  | { ok: true; scheme: ProxyScheme; host: string; port: number }
  | { ok: false; error: string };

/** Accepts `socks5://h:1080`, `https://h`, `h:3128` (-> http), `SOCKS5 h:1080` (PAC syntax). */
export function parseProxy(input: string): ParsedProxy {
  let s = input.trim();
  let scheme: ProxyScheme = 'http';
  const m = /^([a-z0-9]+)(?::\/\/|\s+)(.+)$/i.exec(s);
  if (m) {
    const k = m[1]!.toLowerCase();
    const found =
      k === 'proxy' ? 'http' : (SCHEMES.find((x) => x === k) ?? (k === 'socks' ? 'socks4' : undefined));
    if (!found) return { ok: false, error: `unknown scheme "${m[1]}"` };
    scheme = found;
    s = m[2]!.trim();
  }
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  let host = s;
  let port = DEFAULT_PORT[scheme];
  const colon = s.lastIndexOf(':');
  if (colon > 0 && !(s.charCodeAt(0) === 91 && s.indexOf(']') > colon)) {
    host = s.slice(0, colon);
    const ps = s.slice(colon + 1);
    if (!/^\d{1,5}$/.test(ps)) return { ok: false, error: 'invalid port' };
    port = Number(ps);
  }
  const candidate = { scheme, host: host.toLowerCase(), port };
  const err = validateProxy(candidate);
  return err ? { ok: false, error: err } : { ok: true, ...candidate };
}

export const formatProxy = (p: Pick<ProxyServer, 'scheme' | 'host' | 'port'>): string =>
  `${p.scheme}://${p.host}:${p.port}`;
