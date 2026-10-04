import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ago } from '../src/popup/format.ts';
import { plural, resolveLang, setLang, t } from '../src/popup/i18n.ts';
import { ru } from '../src/popup/ru.ts';

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) =>
    statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : [],
  );

afterEach(() => setLang('en'));

describe('i18n', () => {
  it('English is the key and is returned as is, with placeholders filled', async () => {
    await setLang('en');
    expect(t('Add')).toBe('Add');
    expect(t('{n} selected', { n: 3 })).toBe('3 selected');
    expect(plural(1, 'rule')).toBe('1 rule');
    expect(plural(2, 'rule')).toBe('2 rules');
    expect(ago(0)).toBe('never');
  });
  it('Russian: translations, placeholders and plural forms', async () => {
    await setLang('ru');
    expect(t('Current site')).toBe('Текущий сайт');
    expect(t('{n} selected', { n: 3 })).toBe('Выбрано: 3');
    expect(t('Unknown string stays English')).toBe('Unknown string stays English');
    expect([1, 2, 5, 11, 12, 14, 21, 22, 25, 101, 111].map((n) => plural(n, 'rule'))).toEqual([
      '1 правило',
      '2 правила',
      '5 правил',
      '11 правил',
      '12 правил',
      '14 правил',
      '21 правило',
      '22 правила',
      '25 правил',
      '101 правило',
      '111 правил',
    ]);
    expect(ago(0)).toBe('никогда');
  });
  it('auto language follows the browser UI language', () => {
    expect(resolveLang('auto', 'ru')).toBe('ru');
    expect(resolveLang('auto', 'ru-RU')).toBe('ru');
    expect(resolveLang('auto', 'en-US')).toBe('en');
    expect(resolveLang('auto', 'de')).toBe('en');
    expect(resolveLang('en', 'ru')).toBe('en');
    expect(resolveLang('ru', 'en')).toBe('ru');
  });
  it('every string passed to t() in the popup has a Russian translation (no half-translated UI)', () => {
    const used = new Set<string>();
    for (const f of walk('src/popup').concat(walk('src/shared'))) {
      if (f.endsWith('ru.ts')) continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g))
        used.add((m[1] ?? '').replace(/\\n/g, '\n').replace(/\\'/g, "'"));
    }
    const missing = [...used].filter((k) => !(k in ru.strings));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(100);
  });
  it('no stale Russian keys, and placeholders match the English key', () => {
    for (const [k, v] of Object.entries(ru.strings)) {
      const a = (k.match(/\{\w+\}/g) ?? []).sort();
      const b = (v.match(/\{\w+\}/g) ?? []).sort();
      expect(b, k).toEqual(a);
    }
  });
});
