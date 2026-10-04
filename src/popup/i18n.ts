import type { Language } from '../types/index.ts';

/**
 * Tiny i18n: the English string IS the key. `t('Add')` returns the English text unless a dictionary for the active
 * language was loaded and has an entry. English users never download a dictionary; others load theirs once, before first render.
 * `{name}` placeholders are replaced from `vars`.
 */
export type Lang = 'en' | 'ru';
export interface Dictionary {
  strings: Record<string, string>;
  /** plural forms by key: [one, few, many] for ru */
  plurals: Record<string, [string, string, string]>;
}

let lang: Lang = 'en';
let dict: Dictionary | undefined;

export const currentLang = (): Lang => lang;

export function resolveLang(pref: Language, uiLanguage: string): Lang {
  if (pref === 'en' || pref === 'ru') return pref;
  return uiLanguage.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Loads the dictionary for `l` (no-op for English). */
export async function setLang(l: Lang): Promise<void> {
  lang = l;
  dict = l === 'ru' ? (await import('./ru.ts')).ru : undefined;
}

export function t(s: string, vars?: Record<string, string | number>): string {
  let out = dict?.strings[s] ?? s;
  if (vars) for (const k in vars) out = out.replaceAll(`{${k}}`, String(vars[k]));
  return out;
}

/** "1 rule" / "2 rules" / ru: "1 правило" / "2 правила" / "5 правил". */
export function plural(n: number, key: string): string {
  if (lang === 'ru') {
    const forms = dict?.plurals[key];
    if (forms) {
      const m10 = n % 10;
      const m100 = n % 100;
      const f =
        m10 === 1 && m100 !== 11
          ? forms[0]
          : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)
            ? forms[1]
            : forms[2];
      return `${n} ${f}`;
    }
  }
  return `${n} ${n === 1 ? key : `${key}s`}`;
}
