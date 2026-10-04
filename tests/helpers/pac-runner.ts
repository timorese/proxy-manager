import vm from 'node:vm';

export type FindProxy = (url: string, host: string) => string;

/** Executes PAC text the way a PAC engine would (sloppy-mode global script + PAC helper globals). */
export function loadPac(text: string): FindProxy {
  const ctx = vm.createContext({
    isPlainHostName: (h: string) => !h.includes('.'),
    dnsDomainIs: (h: string, d: string) => h.endsWith(d),
    shExpMatch: (s: string, p: string) =>
      new RegExp(
        `^${p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.')}$`,
      ).test(s),
    dnsResolve: () => '127.0.0.1',
    myIpAddress: () => '127.0.0.1',
    alert: () => {},
  });
  vm.runInContext(text, ctx, { timeout: 5000 });
  const f = (ctx as unknown as { FindProxyForURL: FindProxy }).FindProxyForURL;
  return (url, host) => f(url, host);
}

export const hostOf = (h: string): [string, string] => [`http://${h}/`, h];
export const resolveHost = (f: FindProxy, h: string): string => f(`http://${h}/`, h);
