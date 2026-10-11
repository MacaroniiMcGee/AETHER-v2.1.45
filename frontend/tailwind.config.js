/**
 * Tailwind theme bound to the HV GUI Guidelines (v3.435) token set.
 *
 * Every color resolves to a CSS variable from src/theme/hv-tokens.css, so the
 * whole app follows <html data-theme="dark|light">.
 *
 *  - `hv-*` names are the HV semantic tokens — use these in new code:
 *      bg-hv-widget  border-hv-line  text-hv-text-2  bg-hv-brand/20
 *  - Tailwind's built-in palettes (slate, gray, red, emerald, …) are remapped
 *    onto the same tokens so older class names stay on-guideline in both themes.
 */
const v = (name) => `rgb(var(--hv-${name}) / <alpha-value>)`;

const TOKENS = [
  'surface', 'widget-panel', 'widget', 'popup-panel', 'box', 'modal',
  'line', 'line-strong', 'text', 'text-2', 'text-3', 'text-disabled', 'contrast',
  'brand', 'brand-hover', 'brand-text', 'brand-tint', 'brand-tint-strong', 'brand-fg',
  'warning', 'warning-text', 'warning-tint', 'warning-tint-strong', 'warning-fg',
  'success', 'success-strong', 'success-hover', 'success-text', 'success-tint', 'success-tint-strong', 'success-fg',
  'error', 'error-strong', 'error-hover', 'error-text', 'error-tint', 'error-tint-strong', 'error-fg',
  'info', 'info-strong', 'info-text', 'info-tint', 'info-tint-strong', 'info-fg',
  'purple', 'purple-text', 'purple-tint', 'purple-fg', 'pink', 'violet',
  'data-blue', 'data-blue-tint', 'data-coral', 'data-coral-tint', 'data-emerald', 'data-emerald-tint', 'data-gray', 'data-gray-tint', 'data-green', 'data-green-tint', 'data-indigo', 'data-indigo-tint', 'data-orange', 'data-orange-tint', 'data-pink', 'data-pink-tint', 'data-purple', 'data-purple-tint', 'data-red', 'data-red-tint', 'data-sapphire', 'data-sapphire-tint', 'data-violet', 'data-violet-tint', 'data-yellow', 'data-yellow-tint',
];
const hv = Object.fromEntries(TOKENS.map((t) => [t, v(t)]));

// shade -> token, per family
const neutral = {
  50: v('text'), 100: v('text'), 200: v('text'), 300: v('text-2'), 400: v('text-2'),
  500: v('text-3'), 600: v('line-strong'), 700: v('line'), 800: v('widget'), 900: v('widget-panel'), 950: v('surface'),
};
const status = (s, { strong = s, hover = s, tintStrong = `${s}-tint-strong` } = {}) => ({
  50: v(`${s}-text`), 100: v(`${s}-text`), 200: v(`${s}-text`), 300: v(`${s}-text`), 400: v(`${s}-fg`),
  500: v(s), 600: v(strong), 700: v(hover), 800: v(tintStrong), 900: v(`${s}-tint`), 950: v(`${s}-tint`),
});
const brand = status('brand', { strong: 'brand-hover', hover: 'brand-hover' });
const warning = status('warning');
const success = status('success', { strong: 'success-strong', hover: 'success-hover' });
const error = status('error', { strong: 'error-strong', hover: 'error-hover' });
const info = status('info', { strong: 'info-strong', hover: 'info-strong' });
const purple = {
  50: v('purple-text'), 100: v('purple-text'), 200: v('purple-text'), 300: v('purple-text'), 400: v('purple-fg'),
  500: v('purple'), 600: v('purple'), 700: v('purple'), 800: v('purple-tint'), 900: v('purple-tint'), 950: v('purple-tint'),
};
// HV Data color as a full ramp: light shades + base for marks/text, tint for 800–950 backgrounds
const data = (k) => Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((n) => [n, v(n >= 800 ? `data-${k}-tint` : `data-${k}`)]));
const pink = Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((k) => [k, v('pink')]));

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        hv,
        slate: neutral, gray: neutral, zinc: neutral, neutral, stone: neutral,
        orange: brand,
        amber: warning, yellow: warning,
        green: success, emerald: success, lime: data('green'),
        red: error, rose: error,
        blue: info, sky: data('sapphire'), cyan: data('sapphire'), teal: data('sapphire'), indigo: data('indigo'),
        purple, violet: data('violet'), fuchsia: data('violet'),
        pink,
      },
      fontFamily: {
        sans: ['"Noto Sans"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
      },
      borderRadius: {
        'hv-xs': '4px', 'hv-sm': '8px', 'hv-md': '12px', 'hv-lg': '16px', 'hv-xl': '20px',
      },
      boxShadow: {
        'hv-1': '0 2px 8px rgb(0 0 0 / var(--hv-shadow-1, 0.32))',
        'hv-2': '0 4px 12px rgb(0 0 0 / var(--hv-shadow-2, 0.40))',
        'hv-3': '0 8px 24px rgb(0 0 0 / var(--hv-shadow-3, 0.48))',
      },
    },
  },
  plugins: [],
}
