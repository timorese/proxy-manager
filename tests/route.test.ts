import { describe, expect, it } from 'vitest';
import {
  candidatePatterns,
  describeVia,
  explainRoute,
  hostOfUrl,
  patternForSite,
} from '../src/popup/route.ts';
import { makeEnv, rule } from './helpers/env.ts';

const on = { enabled: true, mode: 'direct' as const, bypassLocal: true };
const have = { proxies: true, pacs: true };

describe('current-site route', () => {
  it('candidate patterns cover the exact host and every wildcard parent', () => {
    expect(candidatePatterns('a.b.com')).toEqual(['a.b.com', '*.a.b.com', '*.b.com', '*.com']);
    expect(candidatePatterns('localhost')).toEqual(['localhost', '*.localhost']);
  });
  it('host of the active tab: http(s) only', () => {
    expect(hostOfUrl('https://Mail.Example.com:8080/x?y#z')).toBe('mail.example.com');
    for (const u of [
      'chrome://extensions',
      'chrome-extension://abc/popup.html',
      'file:///a',
      'about:blank',
      '',
      undefined,
    ])
      expect(hostOfUrl(u)).toBe('');
  });
  it('pattern for "add to list": *.base without www, or exact host', () => {
    expect(patternForSite('www.example.com', true)).toBe('*.example.com');
    expect(patternForSite('mail.example.com', true)).toBe('*.mail.example.com');
    expect(patternForSite('www.example.com', false)).toBe('www.example.com');
  });
  it('rule beats default; exact beats wildcard (spec example)', () => {
    const rules = [rule('*.google.com', 'proxy'), rule('mail.google.com', 'direct')];
    expect(explainRoute('mail.google.com', on, have, rules)).toMatchObject({
      action: 'direct',
      kind: 'rule',
      via: 'mail.google.com',
    });
    expect(explainRoute('maps.google.com', on, have, rules)).toMatchObject({
      action: 'proxy',
      kind: 'rule',
      via: '*.google.com',
    });
  });
  it('falls back to the default mode, plain hostnames bypass', () => {
    expect(explainRoute('x.org', { ...on, mode: 'proxy' }, have, [])).toMatchObject({
      action: 'proxy',
      kind: 'default',
    });
    expect(explainRoute('x.org', { ...on, mode: 'pac' }, have, [])).toMatchObject({
      action: 'pac',
      kind: 'default',
    });
    expect(explainRoute('intranet', { ...on, mode: 'proxy' }, have, [])).toMatchObject({
      action: 'direct',
      kind: 'local',
    });
  });
  it('OFF and actions with nothing behind them show DIRECT with the reason', () => {
    expect(explainRoute('x.org', { ...on, enabled: false }, have, [rule('x.org', 'proxy')])).toMatchObject({
      action: 'direct',
      kind: 'off',
    });
    expect(explainRoute('x.org', on, { proxies: false, pacs: true }, [rule('x.org', 'proxy')])).toMatchObject(
      { action: 'direct', note: 'no proxy enabled' },
    );
    expect(explainRoute('x.org', { ...on, mode: 'pac' }, { proxies: true, pacs: false }, [])).toMatchObject({
      action: 'direct',
      note: 'no PAC source enabled',
    });
  });
  it('describeVia', () => {
    expect(describeVia({ action: 'proxy', kind: 'rule', via: '*.a.com' }, 'direct')).toBe('rule *.a.com');
    expect(describeVia({ action: 'direct', kind: 'default' }, 'direct')).toBe('default (direct mode)');
  });
});

describe('RuleRepository.getMany reads only what it needs', () => {
  it('returns exactly the requested stored patterns', async () => {
    const { repos } = makeEnv();
    await repos.rules.putMany(Array.from({ length: 3000 }, (_, i) => rule(`h${i}.example.com`, 'proxy')));
    await repos.rules.putMany([rule('*.example.com', 'direct'), rule('mail.google.com', 'pac')]);
    const got = await repos.rules.getMany(candidatePatterns('h7.example.com'));
    expect(got.map((r) => r.pattern).sort()).toEqual(['*.example.com', 'h7.example.com']);
    expect(await repos.rules.getMany(['nope.com'])).toEqual([]);
    expect(await repos.rules.getMany([])).toEqual([]);
  });
});
