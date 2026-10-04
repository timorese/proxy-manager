import { describe, expect, it } from 'vitest';
import { buildIndex, lookup } from '../src/domain-rules/matcher.ts';
import { compilePac, type PacConfig } from '../src/pac/compiler.ts';
import type { Action, ProxyServer, Rule } from '../src/types/index.ts';
import { loadPac, resolveHost } from './helpers/pac-runner.ts';

const proxy = (host = '1.2.3.4', port = 1080, scheme: ProxyServer['scheme'] = 'socks5'): ProxyServer => ({
  id: host,
  scheme,
  host,
  port,
  enabled: true,
});
const base = (over: Partial<PacConfig> = {}): PacConfig => ({
  mode: 'direct',
  failoverDirect: true,
  bypassLocal: true,
  proxies: [proxy()],
  rules: [],
  sources: [],
  ...over,
});
const r = (pattern: string, action: Action) => ({ pattern, action });
const GOOD_SRC =
  'function FindProxyForURL(url, host){ return dnsDomainIs(host, ".corp") ? "PROXY corp:8080" : "DIRECT"; }';

describe('PacCompiler: rule priority', () => {
  const rules = [r('example.com', 'pac'), r('*.google.com', 'proxy'), r('mail.google.com', 'direct')];
  const res = compilePac(base({ mode: 'direct', rules, sources: [{ id: 's', text: GOOD_SRC }] }));
  const f = loadPac(res.text);

  it('exact beats wildcard (spec example)', () => {
    expect(resolveHost(f, 'mail.google.com')).toBe('DIRECT');
    expect(resolveHost(f, 'maps.google.com')).toBe('SOCKS5 1.2.3.4:1080; DIRECT');
  });
  it('wildcard matches the base domain and deep subdomains', () => {
    expect(resolveHost(f, 'google.com')).toBe('SOCKS5 1.2.3.4:1080; DIRECT');
    expect(resolveHost(f, 'a.b.c.google.com')).toBe('SOCKS5 1.2.3.4:1080; DIRECT');
  });
  it('exact rule does not leak to subdomains or suffix lookalikes', () => {
    expect(resolveHost(f, 'sub.example.com')).toBe('DIRECT'); // fallback (mode direct)
    expect(resolveHost(f, 'notgoogle.com')).toBe('DIRECT');
    expect(resolveHost(f, 'google.com.evil.org')).toBe('DIRECT');
  });
  it('PAC action consults sources, first non-DIRECT wins, otherwise DIRECT', () => {
    expect(resolveHost(f, 'example.com')).toBe('DIRECT'); // source answers DIRECT for non-.corp
    const g = loadPac(
      compilePac(base({ rules: [r('x.corp', 'pac')], sources: [{ id: 's', text: GOOD_SRC }] })).text,
    );
    expect(resolveHost(g, 'x.corp')).toBe('PROXY corp:8080');
  });
  it('trailing dot in host is tolerated', () => {
    expect(resolveHost(f, 'maps.google.com.')).toBe('SOCKS5 1.2.3.4:1080; DIRECT');
  });
  it('prototype-ish host names do not hit Object.prototype', () => {
    const g = loadPac(compilePac(base({ rules: [r('a.com', 'proxy')] })).text);
    for (const h of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
      expect(resolveHost(g, h)).toBe('DIRECT');
  });
});

describe('PacCompiler: modes and fallback', () => {
  it('mode direct with no effective rules compiles to nothing', () => {
    const res = compilePac(base({ mode: 'direct' }));
    expect(res.kind).toBe('direct');
    expect(res.text).toBe('');
  });
  it('mode proxy routes everything through the chain, but not plain hostnames', () => {
    const f = loadPac(compilePac(base({ mode: 'proxy' })).text);
    expect(resolveHost(f, 'anything.org')).toBe('SOCKS5 1.2.3.4:1080; DIRECT');
    expect(resolveHost(f, 'intranet')).toBe('DIRECT');
    const g = loadPac(compilePac(base({ mode: 'proxy', bypassLocal: false })).text);
    expect(resolveHost(g, 'intranet')).toBe('SOCKS5 1.2.3.4:1080; DIRECT');
  });
  it('mode pac delegates to sources; rules still override', () => {
    const f = loadPac(
      compilePac(
        base({ mode: 'pac', rules: [r('keep.corp', 'direct')], sources: [{ id: 's', text: GOOD_SRC }] }),
      ).text,
    );
    expect(resolveHost(f, 'a.corp')).toBe('PROXY corp:8080');
    expect(resolveHost(f, 'keep.corp')).toBe('DIRECT');
    expect(resolveHost(f, 'other.com')).toBe('DIRECT');
  });
  it('multiple sources: first non-DIRECT answer wins; throwing source is skipped', () => {
    const a = 'function FindProxyForURL(u,h){ throw new Error("boom"); }';
    const b = 'function FindProxyForURL(u,h){ return "DIRECT"; }';
    const c = 'var helper = 1; function FindProxyForURL(u,h){ return "PROXY third:3128"; }';
    const f = loadPac(
      compilePac(
        base({
          mode: 'pac',
          sources: [
            { id: 'a', text: a },
            { id: 'b', text: b },
            { id: 'c', text: c },
          ],
        }),
      ).text,
    );
    expect(resolveHost(f, 'x.com')).toBe('PROXY third:3128');
  });
  it('a source throwing at load time or lacking FindProxyForURL does not break the PAC', () => {
    const bad = 'throw new Error("load");function FindProxyForURL(){}';
    const none = 'var x = 1;';
    const f = loadPac(
      compilePac(
        base({
          mode: 'pac',
          sources: [
            { id: 'a', text: bad },
            { id: 'n', text: none },
          ],
        }),
      ).text,
    );
    expect(resolveHost(f, 'x.com')).toBe('DIRECT');
  });
  it('sources are isolated from each other and from the generated code', () => {
    const a = 'var D = "HACK"; function FindProxyForURL(u,h){ return "PROXY a:1"; }';
    const b = 'function FindProxyForURL(u,h){ return D; }'; // D must be undefined here, not our constant
    const f = loadPac(compilePac(base({ mode: 'pac', sources: [{ id: 'b', text: b }] })).text);
    expect(resolveHost(f, 'x.com')).toBe('DIRECT');
    const g = loadPac(compilePac(base({ mode: 'pac', sources: [{ id: 'a', text: a }] })).text);
    expect(resolveHost(g, 'x.com')).toBe('PROXY a:1');
  });
  it('source ending with a line comment does not swallow our epilogue', () => {
    const f = loadPac(
      compilePac(
        base({
          mode: 'pac',
          sources: [{ id: 'a', text: 'function FindProxyForURL(){return "PROXY z:1"} // end' }],
        }),
      ).text,
    );
    expect(resolveHost(f, 'x.com')).toBe('PROXY z:1');
  });
  it('proxy action without proxies / pac action without sources degrade to DIRECT', () => {
    const res = compilePac(base({ proxies: [], rules: [r('a.com', 'proxy'), r('b.com', 'pac')] }));
    expect(res.kind).toBe('direct');
  });
});

describe('PacCompiler: chains', () => {
  it('serialises multiple proxies with DIRECT failover', () => {
    const proxies = [
      proxy('1.1.1.1', 1080, 'socks5'),
      proxy('backup', 1080, 'socks5'),
      proxy('p.example.com', 443, 'https'),
      proxy('h', 3128, 'http'),
      proxy('s4', 9050, 'socks4'),
    ];
    const f = loadPac(compilePac(base({ mode: 'proxy', proxies })).text);
    expect(resolveHost(f, 'x.com')).toBe(
      'SOCKS5 1.1.1.1:1080; SOCKS5 backup:1080; HTTPS p.example.com:443; PROXY h:3128; SOCKS4 s4:9050; DIRECT',
    );
  });
  it('failoverDirect=false omits DIRECT', () => {
    const f = loadPac(compilePac(base({ mode: 'proxy', failoverDirect: false })).text);
    expect(resolveHost(f, 'x.com')).toBe('SOCKS5 1.2.3.4:1080');
  });
  it('invalid proxy entries are ignored with a warning', () => {
    const bad = { ...proxy('bad host!', 1), id: 'bad' };
    const res = compilePac(base({ mode: 'proxy', proxies: [bad, proxy()] }));
    expect(res.warnings.join()).toMatch(/invalid proxies/);
    expect(resolveHost(loadPac(res.text), 'x.com')).toBe('SOCKS5 1.2.3.4:1080; DIRECT');
  });
});

describe('PacCompiler: normalisation, determinism, size', () => {
  it('normalises and dedupes rules; later duplicate wins', () => {
    const res = compilePac(
      base({ rules: [r('Example.com.', 'direct'), r('example.com', 'proxy'), r('bad host', 'proxy')] }),
    );
    expect(res.stats.duplicates).toBe(1);
    expect(res.stats.invalid).toBe(1);
    expect(resolveHost(loadPac(res.text), 'example.com')).toBe('SOCKS5 1.2.3.4:1080; DIRECT');
  });
  it('drops redundant rules without changing behaviour', () => {
    const rules = [
      r('*.a.com', 'proxy'),
      r('x.a.com', 'proxy'),
      r('*.y.a.com', 'proxy'),
      r('z.a.com', 'direct'),
      r('*.b.com', 'direct'),
    ];
    const res = compilePac(base({ rules }));
    expect(res.stats.redundant).toBe(3); // x.a.com, *.y.a.com, *.b.com (== fallback)
    expect(res.rulesCompiled).toBe(2);
  });
  it('output is independent of rule order', () => {
    const rules = Array.from({ length: 200 }, (_, i) =>
      r(i % 7 ? `h${i}.ex${i % 13}.com` : `*.w${i}.org`, (['direct', 'proxy', 'pac'] as const)[i % 3]!),
    );
    const src = [{ id: 's', text: GOOD_SRC }];
    const a = compilePac(base({ rules, sources: src })).text;
    const b = compilePac(base({ rules: [...rules].reverse(), sources: src })).text;
    expect(a).toBe(b);
  });
  it('is far smaller than the legacy encoding (JSON object literal)', () => {
    const rules = Array.from({ length: 10000 }, (_, i) => r(`host${i}.example${i % 97}.com`, 'proxy'));
    const res = compilePac(base({ rules }));
    const legacy = JSON.stringify(Object.fromEntries(rules.map((x) => [x.pattern, 'yes']))).length;
    expect(res.text.length).toBeLessThan(legacy * 0.75);
  });
});

describe('PAC output matches the reference matcher (randomised)', () => {
  it('agrees on 20k random lookups', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const labels = ['a', 'b', 'c', 'd', 'mail', 'www', 'x1'];
    const tlds = ['com', 'org', 'io'];
    const host = () => {
      const n = 1 + Math.floor(rnd() * 3);
      const parts: string[] = [];
      for (let i = 0; i < n; i++) parts.push(labels[Math.floor(rnd() * labels.length)]!);
      parts.push(tlds[Math.floor(rnd() * tlds.length)]!);
      return parts.join('.');
    };
    const acts: Action[] = ['direct', 'proxy'];
    const rules: Rule[] = [];
    for (let i = 0; i < 120; i++) {
      const h = host();
      rules.push({
        pattern: rnd() < 0.5 ? `*.${h}` : h,
        action: acts[Math.floor(rnd() * 2)]!,
        enabled: true,
      });
    }
    for (const mode of ['direct', 'proxy'] as const) {
      const res = compilePac(base({ mode, bypassLocal: false, rules }));
      const f = res.kind === 'pac' ? loadPac(res.text) : () => 'DIRECT';
      const idx = buildIndex(rules);
      const chain = 'SOCKS5 1.2.3.4:1080; DIRECT';
      for (let i = 0; i < 10000; i++) {
        const h = host();
        const hit = lookup(idx, h);
        const action = hit?.action ?? mode;
        expect(f(`http://${h}/`, h), `${mode} ${h}`).toBe(action === 'proxy' ? chain : 'DIRECT');
      }
    }
  });
});

describe("PacCompiler: override PAC proxies with the user's own", () => {
  const generic =
    'function FindProxyForURL(u,h){ return h==="blocked.example" ? "HTTP 127.0.0.1:1080; SOCKS5 127.0.0.1:1080; DIRECT" : "DIRECT"; }';
  const run = (overridePac: boolean, proxies = [proxy('10.0.0.5', 1081, 'socks5')]) =>
    loadPac(
      compilePac(base({ mode: 'pac', overridePac, proxies, sources: [{ id: 's', text: generic }] })).text,
    );

  it("off: the PAC's own proxies are used", () => {
    expect(resolveHost(run(false), 'blocked.example')).toBe(
      'HTTP 127.0.0.1:1080; SOCKS5 127.0.0.1:1080; DIRECT',
    );
  });
  it('on: the user chain replaces the PAC answer; DIRECT answers stay DIRECT', () => {
    const f = run(true);
    expect(resolveHost(f, 'blocked.example')).toBe('SOCKS5 10.0.0.5:1081; DIRECT');
    expect(resolveHost(f, 'other.example')).toBe('DIRECT');
  });
  it('on without any enabled proxy: no effect (PAC answer kept)', () => {
    expect(resolveHost(run(true, []), 'blocked.example')).toBe(
      'HTTP 127.0.0.1:1080; SOCKS5 127.0.0.1:1080; DIRECT',
    );
  });
  it('applies to PAC rules too', () => {
    const f = loadPac(
      compilePac(
        base({
          overridePac: true,
          rules: [r('blocked.example', 'pac')],
          sources: [{ id: 's', text: generic }],
        }),
      ).text,
    );
    expect(resolveHost(f, 'blocked.example')).toBe('SOCKS5 1.2.3.4:1080; DIRECT');
  });
});
