// ===== Clipboard fallback for insecure contexts (HTTP/LAN access) =====
// navigator.clipboard.writeText only works on HTTPS or localhost. When this
// app is accessed at 192.168.x.x over plain HTTP, the API exists but rejects.
// This wraps writeText with an execCommand fallback. Result: every Copy
// button anywhere in the app just works, no per-component patching needed.
(function installClipboardFallback() {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return;
  const fallback = (text: string) => new Promise<void>((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('execCommand copy returned false'));
    } catch (e) { reject(e as Error); }
  });
  if (!navigator.clipboard) {
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: fallback }, configurable: true,
      });
      console.log('[clipboard] polyfill installed (no native clipboard)');
    } catch (e) { console.warn('[clipboard] polyfill failed:', e); }
  } else if (typeof window !== 'undefined' && !window.isSecureContext) {
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    (navigator.clipboard as any).writeText = async (text: string) => {
      try { return await orig(text); }
      catch { return fallback(text); }
    };
    console.log('[clipboard] wrapped writeText with execCommand fallback');
  }
})();

import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
