import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useHvTheme } from './theme';

/** HV top-bar icon button that switches between Dark and Light mode. */
export default function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useHvTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={`inline-flex items-center justify-center w-9 h-9 rounded-hv-xs text-hv-text-2 hover:bg-hv-contrast/5 active:bg-hv-contrast/10 ${className}`}
    >
      {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
    </button>
  );
}
