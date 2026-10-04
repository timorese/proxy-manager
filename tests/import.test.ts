import { describe, expect, it } from 'vitest';
import { exportRules, parseImport } from '../src/domain-rules/import.ts';

describe('parseImport', () => {
  it('plain list uses the default action', () => {
    const r = parseImport('google.com\nyoutube.com\n*.example.org\n', 'proxy');
    expect(r.rules).toEqual([
      { pattern: 'google.com', action: 'proxy', enabled: true },
      { pattern: 'youtube.com', action: 'proxy', enabled: true },
      { pattern: '*.example.org', action: 'proxy', enabled: true },
    ]);
    expect(r.invalid).toBe(0);
  });
  it('explicit actions, separators, case, legacy yes/no, CRLF', () => {
    const r = parseImport(
      'google.com DIRECT\r\nyoutube.com\tproxy\r\nexample.org,PAC\r\na.com yes\r\nb.com no\r\n',
    );
    expect(r.rules.map((x) => `${x.pattern}:${x.action}`)).toEqual([
      'google.com:direct',
      'youtube.com:proxy',
      'example.org:pac',
      'a.com:proxy',
      'b.com:direct',
    ]);
  });
  it('skips comments and blanks; reports bad lines with numbers; dedupes (last wins)', () => {
    const r = parseImport('# c\n// c\n\ngood.com DIRECT\nbad host\nx.com NOPE\ngood.com PROXY\n');
    expect(r.rules).toEqual([{ pattern: 'good.com', action: 'proxy', enabled: true }]);
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toBe(2);
    expect(r.issues.map((i) => i.line)).toEqual([5, 6]);
  });
  it('caps the issue list', () => {
    const r = parseImport(Array.from({ length: 1000 }, () => 'bad host').join('\n'));
    expect(r.invalid).toBe(1000);
    expect(r.issues).toHaveLength(100);
  });
  it('export round-trips including disabled rules', () => {
    const rules = [
      { pattern: 'b.com', action: 'direct' as const, enabled: false },
      { pattern: '*.a.com', action: 'pac' as const, enabled: true },
    ];
    const text = exportRules(rules);
    expect(text).toBe('*.a.com PAC\n#off b.com DIRECT\n');
    expect(parseImport(text).rules.sort((x, y) => x.pattern.localeCompare(y.pattern))).toEqual(
      rules.sort((x, y) => x.pattern.localeCompare(y.pattern)),
    );
  });
  it('handles 50 000 lines', () => {
    const text = Array.from(
      { length: 50_000 },
      (_, i) => `h${i}.example${i % 50}.com ${i % 2 ? 'DIRECT' : 'PROXY'}`,
    ).join('\n');
    const t = performance.now();
    const r = parseImport(text);
    expect(r.rules).toHaveLength(50_000);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('real-world wildcard lists', () => {
  it('imports `*.domain` lists with IPs, deep hosts, bare domains and a markdown-pasted link', () => {
    const text = [
      '*.2ip.io',
      '*.62.60.235.31',
      '*.chat.openai.com.cdn.cloudflare.net',
      '*.instagram.fiev22-1.fna.fbcdn.net',
      '*.[www.instagram.com](https://www.instagram.com)',
      '62.60.235.31',
      'api.anthropic.com',
      'claude.ai',
    ].join('\n');
    const r = parseImport(text, 'proxy');
    expect(r.invalid).toBe(0);
    expect(r.rules.map((x) => x.pattern)).toEqual([
      '*.2ip.io',
      '*.62.60.235.31',
      '*.chat.openai.com.cdn.cloudflare.net',
      '*.instagram.fiev22-1.fna.fbcdn.net',
      '*.www.instagram.com',
      '62.60.235.31',
      'api.anthropic.com',
      'claude.ai',
    ]);
    expect(r.rules.every((x) => x.action === 'proxy' && x.enabled)).toBe(true);
  });
});
