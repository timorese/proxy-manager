import { describe, expect, it } from 'vitest';
import { parseProxy, serializeChain, serializeProxy, validateProxy } from '../src/proxy/serialize.ts';
import { proxyServer } from './helpers/env.ts';

describe('proxy serialisation', () => {
  it('maps schemes to PAC keywords', () => {
    expect(serializeProxy({ scheme: 'http', host: 'H.example', port: 3128 })).toBe('PROXY h.example:3128');
    expect(serializeProxy({ scheme: 'https', host: 'p', port: 443 })).toBe('HTTPS p:443');
    expect(serializeProxy({ scheme: 'socks4', host: 'p', port: 1 })).toBe('SOCKS4 p:1');
    expect(serializeProxy({ scheme: 'socks5', host: '127.0.0.1', port: 1080 })).toBe('SOCKS5 127.0.0.1:1080');
  });
  it('builds chains (spec examples)', () => {
    expect(serializeChain([proxyServer('a', 'host', 8080, 'http')], true)).toBe('PROXY host:8080; DIRECT');
    expect(serializeChain([proxyServer('a', 'host', 1080), proxyServer('b', 'backup', 1080)], true)).toBe(
      'SOCKS5 host:1080; SOCKS5 backup:1080; DIRECT',
    );
    expect(serializeChain([proxyServer('a', 'host', 1080)], false)).toBe('SOCKS5 host:1080');
    expect(serializeChain([], false)).toBe('DIRECT');
  });
  it('validates ports and hosts, blocks anything that could inject PAC syntax', () => {
    expect(validateProxy({ scheme: 'http', host: 'a.b', port: 0 })).toMatch(/port/);
    expect(validateProxy({ scheme: 'http', host: 'a.b', port: 65536 })).toMatch(/port/);
    expect(validateProxy({ scheme: 'http', host: 'a.b', port: 1.5 })).toMatch(/port/);
    expect(validateProxy({ scheme: 'http', host: 'a";alert(1);"', port: 80 })).toMatch(/host/);
    expect(validateProxy({ scheme: 'http', host: 'a b', port: 80 })).toMatch(/host/);
    expect(validateProxy({ scheme: 'http', host: '[::1]', port: 80 })).toBe('');
    expect(validateProxy({ scheme: 'http', host: '10.0.0.1', port: 80 })).toBe('');
  });
});

describe('parseProxy', () => {
  const p = (s: string) => {
    const r = parseProxy(s);
    return r.ok ? `${r.scheme}://${r.host}:${r.port}` : `ERR ${r.error}`;
  };
  it('parses URL, bare and PAC-style forms with default ports', () => {
    expect(p('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
    expect(p('https://Proxy.Example.com')).toBe('https://proxy.example.com:443');
    expect(p('proxy.example.com:3128')).toBe('http://proxy.example.com:3128');
    expect(p('SOCKS5 1.2.3.4:1080')).toBe('socks5://1.2.3.4:1080');
    expect(p('PROXY h:8080')).toBe('http://h:8080');
    expect(p('socks://h')).toBe('socks4://h:1080');
    expect(p('http://[::1]:8080')).toBe('http://[::1]:8080');
  });
  it('rejects garbage', () => {
    expect(p('ftp://h:1')).toMatch(/^ERR/);
    expect(p('h:99999')).toMatch(/^ERR/);
    expect(p('h:abc')).toMatch(/^ERR/);
    expect(p('')).toMatch(/^ERR/);
    expect(p('bad host:1')).toMatch(/^ERR/);
  });
});
