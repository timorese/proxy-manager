import { describe, expect, it } from 'vitest';
import { applyMigration } from '../src/migration/in-place.ts';
import { mapLegacy } from '../src/migration/legacy.ts';
import { makeEnv } from './helpers/env.ts';
import { loadPac, resolveHost } from './helpers/pac-runner.ts';

const LEGACY = {
  domainExceptions: {
    '*.google.com': 'yes',
    'mail.google.com': 'no',
    'Bad Domain!': 'yes',
    'x.org': 'maybe',
  },
  proxies: [
    { id: 1, url: 'socks5://1.2.3.4:1080' },
    { id: 2, url: 'http://proxy.example:3128' },
    { id: 3, url: '://??' },
  ],
  proxyActive: true,
  pacScripts: [
    {
      id: 1,
      name: 'Corp',
      content: 'function FindProxyForURL(){return "DIRECT"}',
      enabled: true,
      sourceType: 'url',
      sourceUrl: 'https://pac.example/p.pac',
    },
    {
      id: 2,
      name: 'Inline',
      content: 'function FindProxyForURL(){return "DIRECT"}',
      enabled: false,
      sourceType: 'plain',
      sourceUrl: null,
    },
    { id: 3, name: 'Empty', content: '  ', enabled: true },
  ],
};

describe('legacy -> new model mapping', () => {
  const plan = mapLegacy(LEGACY, 1000);
  it('maps exceptions: yes -> proxy, no -> direct; skips junk with warnings', () => {
    expect(plan.rules).toEqual([
      { pattern: '*.google.com', action: 'proxy', enabled: true },
      { pattern: 'mail.google.com', action: 'direct', enabled: true },
    ]);
    expect(plan.warnings.join('|')).toMatch(/Bad Domain!/);
  });
  it('maps proxies and skips invalid ones', () => {
    expect(plan.proxies.map((p) => `${p.scheme}://${p.host}:${p.port}`)).toEqual([
      'socks5://1.2.3.4:1080',
      'http://proxy.example:3128',
    ]);
  });
  it('maps PAC scripts (url vs inline, enabled flag) and drops empty ones', () => {
    expect(plan.pacs.map((p) => [p.source.name, p.source.kind, p.source.enabled, p.source.url])).toEqual([
      ['Corp', 'url', true, 'https://pac.example/p.pac'],
      ['Inline', 'inline', false, ''],
    ]);
  });
  it('legacy without PAC scripts maps to mode direct + rules (that is what it did)', () => {
    const p = mapLegacy({ ...LEGACY, pacScripts: [] });
    expect(p.settings).toMatchObject({ enabled: true, mode: 'direct' });
  });
  it('warns about the unrepresentable "override PAC" behaviour', () => {
    expect(plan.warnings.join('|')).toMatch(/override PAC/);
  });

  it('applied plan produces working routing end-to-end', async () => {
    const env = makeEnv();
    await applyMigration(mapLegacy({ ...LEGACY, pacScripts: [] }), env.repos);
    await env.engine.sync();
    const f = loadPac(env.proxy.pac());
    expect(resolveHost(f, 'maps.google.com')).toBe('SOCKS5 1.2.3.4:1080; PROXY proxy.example:3128; DIRECT');
    expect(resolveHost(f, 'mail.google.com')).toBe('DIRECT');
    expect(resolveHost(f, 'other.org')).toBe('DIRECT');
  });
});
