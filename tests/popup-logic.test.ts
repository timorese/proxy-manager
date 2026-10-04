import { describe, expect, it } from 'vitest';
import { ago } from '../src/popup/format.ts';
import { collectErrors, describeStatus } from '../src/popup/status.ts';
import { computeWindow } from '../src/popup/virtual-list.ts';
import { buildDiagnostics } from '../src/shared/diagnostics.ts';
import { DEFAULT_SETTINGS, EMPTY_STATE } from '../src/types/index.ts';
import { emptyMeta, pacSource, proxyServer } from './helpers/env.ts';

const NOW = 1_700_000_000_000;

describe('status view', () => {
  const settings = { ...DEFAULT_SETTINGS, enabled: true, mode: 'pac' as const };
  const state = { ...EMPTY_STATE, appliedRev: 'r1', rulesTotal: 1243 };
  const pacs = [
    pacSource('a', {
      kind: 'url',
      url: 'https://x/p.pac',
      fetch: emptyMeta({ lastSuccessAt: NOW - 120_000 }),
    }),
  ];

  it('matches the spec screen: ACTIVE / PAC + rules / proxies / rules / updated 2 min ago', () => {
    const s = describeStatus(settings, [proxyServer('p', '1.2.3.4', 1080)], state, 'r1', pacs, NOW);
    expect(s).toMatchObject({
      label: 'ACTIVE',
      tone: 'ok',
      modeText: 'PAC + rules',
      rules: 1243,
      pac: 'Updated 2 min ago',
    });
    expect(s.proxies).toEqual(['SOCKS5 1.2.3.4:1080']);
  });
  it('OFF, PENDING (revision not applied yet), ERROR (rejected), warn (non-fatal errors)', () => {
    expect(describeStatus({ ...settings, enabled: false }, [], state, 'r1', pacs, NOW).label).toBe('OFF');
    expect(describeStatus(settings, [], state, 'r2', pacs, NOW).label).toBe('PENDING');
    const rejected = { ...state, errors: [{ code: 'proxy_rejected' as const, message: 'x', at: 1 }] };
    expect(describeStatus(settings, [], rejected, 'r1', pacs, NOW).label).toBe('ERROR');
    const warn = { ...state, errors: [{ code: 'invalid_rule' as const, message: 'x', at: 1 }] };
    expect(describeStatus(settings, [], warn, 'r1', pacs, NOW)).toMatchObject({
      label: 'ACTIVE',
      tone: 'warn',
    });
  });
  it('only enabled proxies are listed; PAC line before pacs loaded / none / never downloaded', () => {
    const ps = [proxyServer('a', 'a.com', 1), proxyServer('b', 'b.com', 2, 'http', false)];
    expect(describeStatus(settings, ps, state, 'r1', undefined).pac).toBe('…');
    expect(describeStatus(settings, ps, state, 'r1', []).pac).toBe('—');
    expect(describeStatus(settings, ps, state, 'r1', [pacSource('x', { kind: 'url' })]).pac).toBe(
      'Not downloaded yet',
    );
    expect(describeStatus(settings, ps, state, 'r1', []).proxies).toHaveLength(1);
  });
  it('surfaces failed PAC downloads next to sync errors', () => {
    const failing = [
      pacSource('u', { name: 'Corp', kind: 'url', fetch: emptyMeta({ error: 'timeout', lastAttemptAt: 5 }) }),
    ];
    expect(collectErrors(EMPTY_STATE, failing)).toEqual([
      { code: 'pac_fetch_failed', message: 'Corp: timeout', at: 5 },
    ]);
  });
  it('relative time', () => {
    expect(ago(0, NOW)).toBe('never');
    expect(ago(NOW - 3000, NOW)).toBe('just now');
    expect(ago(NOW - 30_000, NOW)).toBe('30 s ago');
    expect(ago(NOW - 3 * 3600_000, NOW)).toBe('3 h ago');
  });
});

describe('virtual list window', () => {
  it('renders O(viewport) rows regardless of total', () => {
    for (const total of [0, 10, 10_000, 50_000]) {
      const w = computeWindow(0, 300, 28, total, 4);
      expect(w.count).toBeLessThanOrEqual(Math.ceil(300 / 28) + 5);
    }
    expect(computeWindow(0, 300, 28, 0)).toEqual({ first: 0, count: 0 });
  });
  it('covers exactly the visible range plus overscan and clamps at the end', () => {
    const w = computeWindow(28 * 1000, 280, 28, 50_000, 3);
    expect(w.first).toBe(997);
    expect(w.first + w.count - 1).toBe(1000 + 10 + 3);
    const end = computeWindow(28 * 49_990, 280, 28, 50_000, 3);
    expect(end.first + end.count).toBe(50_000);
  });
});

describe('diagnostics export is privacy-safe', () => {
  it('contains no rule domains, proxy hosts, PAC paths/queries or bodies', () => {
    const d = buildDiagnostics({
      version: '2.0.0',
      userAgent: 'UA',
      settings: DEFAULT_SETTINGS,
      proxies: [proxyServer('p', 'secret-proxy.corp.example', 1080), proxyServer('q', '10.1.2.3', 8080)],
      pacs: [
        pacSource('u', {
          name: 'Private Name',
          kind: 'url',
          url: 'https://user:pw@pac.corp.example/secret/path.pac?token=abc',
        }),
      ],
      state: EMPTY_STATE,
      rulesTotal: 3,
      rulesEnabled: 2,
      schema: 1,
      now: NOW,
    });
    const json = JSON.stringify(d);
    for (const leak of ['secret-proxy', '10.1.2.3', 'secret/path', 'token=abc', 'user:pw', 'Private Name'])
      expect(json).not.toContain(leak);
    expect(d.pacSources[0]?.origin).toBe('https://pac.corp.example');
    expect(d.proxies.map((p) => p.hostKind)).toEqual(['name', 'ip']);
  });
});
