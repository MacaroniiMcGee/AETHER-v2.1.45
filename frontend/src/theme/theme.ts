// HV theme state: <html data-theme="dark|light">, persisted per browser.
import { useEffect, useState } from 'react';

export type HvTheme = 'dark' | 'light';
const KEY = 'hv-theme';

export function getTheme(): HvTheme {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

export function applyTheme(t: HvTheme) {
  const el = document.documentElement;
  el.classList.add('hv-theme-switching');
  el.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent('hv-theme', { detail: t }));
  window.setTimeout(() => el.classList.remove('hv-theme-switching'), 200);
}

/** Current theme, kept in sync across every component that uses it. */
export function useHvTheme(): [HvTheme, (t: HvTheme) => void] {
  const [theme, setTheme] = useState<HvTheme>(getTheme);
  useEffect(() => {
    const on = (e: Event) => setTheme((e as CustomEvent<HvTheme>).detail);
    window.addEventListener('hv-theme', on);
    return () => window.removeEventListener('hv-theme', on);
  }, []);
  return [theme, applyTheme];
}
