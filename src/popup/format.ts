import { plural as pluralize, t } from './i18n.ts';

export function ago(ts: number, now = Date.now()): string {
  if (!ts) return t('never');
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return t('just now');
  if (s < 60) return t('{n} s ago', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('{n} min ago', { n: m });
  const hr = Math.round(m / 60);
  if (hr < 48) return t('{n} h ago', { n: hr });
  return t('{n} d ago', { n: Math.round(hr / 24) });
}

export const fmtBytes = (n: number): string =>
  n < 1024
    ? t('{n} B', { n })
    : n < 1048576
      ? t('{n} KB', { n: (n / 1024).toFixed(1) })
      : t('{n} MB', { n: (n / 1048576).toFixed(2) });
export const plural = pluralize;

export function download(name: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
