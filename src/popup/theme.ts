import type { Theme } from '../types/index.ts';

/** Applies the theme and caches it for public/theme-boot.js, which sets it before first paint on the next open. */
export function applyTheme(t: Theme): void {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem('theme', t);
  } catch {}
}
