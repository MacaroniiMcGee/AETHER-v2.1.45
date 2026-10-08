#!/usr/bin/env python3
"""
hv-pages.py — bring Aether's standalone pages (frontend/public/*.html) onto the
HV GUI Guidelines tokens, with the same Dark/Light theme as the app.

Run from frontend/:  python3 scripts/hv-pages.py [--apply]

For each page it:
  1. injects the HV token stylesheet (src/theme/hv-tokens.css) and Noto Sans
     (served from /hv-fonts/, so it works offline on the Pi);
  2. injects a tiny script that follows Aether's theme: it reads the parent
     app's <html data-theme> (the pages run in a same-origin iframe), falls back
     to localStorage 'hv-theme', and updates live when the theme is switched;
  3. maps the page's own :root palette onto HV tokens (hand-written maps below);
  4. converts the remaining colors in its <style> blocks with hv-convert.py.
Script colors are left alone on purpose: in Board Blueprint Studio they are
physical wire/LED/part colors, in the OnCAFE console builder they style the
helper scripts that run inside the OnCAFE app. Safe to re-run.
"""
import importlib.util, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
FE = HERE.parent
spec = importlib.util.spec_from_file_location('hvc', HERE / 'hv-convert.py')
hvc = importlib.util.module_from_spec(spec); spec.loader.exec_module(hvc)

T = lambda name, a=None: f'rgb(var(--hv-{name}))' if a is None else f'rgb(var(--hv-{name}) / {a})'
NOTO = '"Noto Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'

PAGES = {
    'oncafe-console-builder.html': {
        '--bg': T('widget-panel'), '--surface': T('widget'), '--surface-2': T('popup-panel'), '--inset': T('surface'),
        '--border': T('line'), '--border-soft': T('line', .6),
        '--text': T('text'), '--muted': T('text-2'), '--faint': T('text-3'),
        '--amber': T('brand'), '--amber-bright': T('brand-text'), '--amber-dim': T('brand', .15),
        '--green': T('success-text'), '--red': T('error-text'), '--red-dim': T('error-tint'),
        '--disp': NOTO, '--body': NOTO,
        '--amber-grad': f'linear-gradient(120deg,{T("brand")},{T("brand")})',
    },
    'board-blueprint-studio.html': {
        '--bg': T('surface'), '--chrome': T('widget'), '--panel': T('widget'), '--well': T('widget-panel'), '--raise': T('popup-panel'),
        '--ink': T('text'), '--ink2': T('text-2'), '--muted': T('text-2'), '--dim': T('text-3'),
        '--line': T('line'), '--line2': T('line-strong'),
        '--accent': T('brand'), '--accent-hi': T('brand-text'), '--accent-ink': '#FFFFFF', '--accent-soft': T('brand-tint'),
        '--sel': T('info'), '--sel-soft': T('info', .16),
        '--go': T('success-tint-strong'), '--go-line': T('success'), '--go-ink': T('success-text'),
        '--warn': T('warning'), '--warn-soft': T('warning', .14), '--err': T('error-text'), '--err-line': T('error-hover'),
        '--err-ink': T('error-text'), '--err-soft': T('error', .15), '--ok': T('success'),
        '--ui': NOTO, '--hover': T('contrast', .05),
    },
}
# Individual CSS rules to re-theme (page, exact old text, new text)
EXTRA = [
    ('board-blueprint-studio.html', 'button.primary:hover { background: #36553E; }', f'button.primary:hover {{ background: {T("success", .3)}; }}'),
    ('board-blueprint-studio.html', '  color-scheme: dark;\n}', '}'),   # the token sheet sets color-scheme per theme
]
# Board Blueprint Studio's main stylesheet also styles the drawing (selection handles,
# print sheet) with hex colors, so there only the translucent rgba() chrome colors
# (panels, overlays) are converted; its hex colors are left as drawn.
CONVERT_STYLE_BLOCKS = {'oncafe-console-builder.html': 'all', 'board-blueprint-studio.html': 'rgba'}


# ── HV component layer: restyles each page's own components to HV GUI specs.
# Appended last (and prefixed with `html`) so it wins over the page's styles,
# including CSS the page injects at runtime. Markup and scripts are untouched.
HV_BASE = """
/* HV Button — Primary (orange) / Secondary (contrast 14%) / Tertiary (outline); 4px radius */
html { --hv-btn-h: 32px; }
"""
LAYERS = {
'oncafe-console-builder.html': """
html { --shadow-sm: 0 1px 2px rgb(0 0 0 / var(--hv-shadow-1, .32)); --shadow: 0 2px 8px rgb(0 0 0 / var(--hv-shadow-1, .32)); }
html body { background: rgb(var(--hv-surface)); font-family: var(--body); font-size: 14px; }
html .landing::before { display: none; }
/* Type: sentence case, Noto Sans (code and keys stay monospace) */
html .brand .sub, html .pill, html .conn h2, html .bay-label, html .bay-group, html .bay-sub, html .soon-tag, html label.lbl,
html .cfg-block .cfg-sub, html .term-head .ttl, html .landing .eyebrow, html .task i, html .sr-title, html .om-t, html .om-s,
html .surface-tabs button, html .adv-toggle, html .ghost-btn, html .home-btn, html .chip, html .copy, html .dl, html .step .num,
html .pk-head { font-family: var(--body); letter-spacing: 0; text-transform: none; }
html .brand h1 { font-family: var(--body); font-size: 18px; line-height: 24px; letter-spacing: 0; }
html .brand .sub { font-size: 12px; color: rgb(var(--hv-text-3)); }
html .landing h2 { font-family: var(--body); font-size: 28px; line-height: 36px; letter-spacing: 0; }
html .landing .eyebrow, html .task i { font-size: 12px; font-weight: 600; color: rgb(var(--hv-brand-fg)); }
html .card-head h3, html .task b, html .step h4 { font-family: var(--body); letter-spacing: 0; }
html .card-head h3 { font-size: 20px; line-height: 28px; font-weight: 700; }
html label.lbl { font-size: 12px; line-height: 18px; font-weight: 500; color: rgb(var(--hv-text-2)); }
html .sr-title, html .cfg-block .cfg-sub, html .conn h2 { font-size: 14px; line-height: 20px; font-weight: 600; color: rgb(var(--hv-text)); }
html .term-head .ttl, html .om-s, html .om-t { font-size: 12px; }
/* Navigation menu (left bay): 1-depth group titles 14/20 semibold, items 14px */
html .bay-group { font-size: 14px; line-height: 20px; font-weight: 600; color: rgb(var(--hv-text)); }
html .bay-label, html .bay-sub { font-size: 12px; font-weight: 500; color: rgb(var(--hv-text-3)); }
html .act { border-radius: 4px; font-size: 14px; }
html .act.on { background: rgb(var(--hv-brand) / .15); color: rgb(var(--hv-text)); }
html .soon-tag { font-size: 11px; border-radius: 9px; }
/* Tabs / segmented controls → HV button group */
html .surface-tabs, html .seg { border-radius: 4px; padding: 2px; background: rgb(var(--hv-contrast) / .04); border-color: rgb(var(--hv-line)); }
html .surface-tabs button, html .seg button { border-radius: 4px; font-size: 13px; font-weight: 600; }
html .seg button.on, html .surface-tabs button.on, html .surface-tabs button[aria-selected=true] { background: rgb(var(--hv-contrast) / .14); color: rgb(var(--hv-text)); box-shadow: none; }
/* Containers: 8px radius, HV shadow */
html .card, html .landing, html .term, html .conn, html aside.bay, html .cfg-block, html .step, html .task, html .sr, html .pk, html .om-node { border-radius: 8px; box-shadow: none; }
html .card, html .landing { box-shadow: var(--shadow); }
html .mark, html .mark::after { border-radius: 8px; }
html .step .num { border-radius: 4px; }
/* Inputs: Noto Sans 14px, 36px, 4px radius */
html input[type=text], html input[type=number], html input[type=time], html input[type=date], html select, html textarea {
  font-family: var(--body); font-size: 14px; border-radius: 4px; border-color: rgb(var(--hv-line-strong)); }
html input[type=text], html input[type=number], html input[type=time], html input[type=date], html select { min-height: 36px; }
html input:focus, html select:focus, html textarea:focus { border-color: rgb(var(--hv-info)); box-shadow: none; outline: none; }
/* Buttons */
html .copy, html .landing .cta { background: rgb(var(--hv-brand)); color: #FFFFFF; border: 0; border-radius: 4px; box-shadow: none;
  font-family: var(--body); font-size: 14px; font-weight: 600; min-height: 36px; padding: 0 16px; }
html .copy:hover, html .landing .cta:hover { background: rgb(var(--hv-brand-hover)); }
html .copy.done { background: rgb(var(--hv-success-tint)); color: rgb(var(--hv-success-fg)); box-shadow: inset 0 0 0 1px rgb(var(--hv-success) / .4); }
html .sr-steps li.done .sr-n { background: rgb(var(--hv-success-tint)); border-color: rgb(var(--hv-success) / .5); color: rgb(var(--hv-success-fg)); }
html .ghost-btn, html .home-btn, html .dl { background: rgb(var(--hv-contrast) / .14); color: rgb(var(--hv-text)); border: 1px solid transparent;
  border-radius: 4px; font-size: 14px; font-weight: 600; min-height: 32px; padding: 0 12px; }
html .ghost-btn:hover, html .home-btn:hover, html .dl:hover { background: rgb(var(--hv-contrast) / .21); color: rgb(var(--hv-text)); }
html .home-btn.on { background: rgb(var(--hv-brand) / .15); color: rgb(var(--hv-brand-fg)); border-color: transparent; }
html .chip { border-radius: 16px; font-size: 13px; min-height: 32px; }
html .chip.on { background: rgb(var(--hv-brand)); color: #FFFFFF; box-shadow: none; }
html .pill { border-radius: 12px; font-size: 12px; }
html .run-hint .n { color: #FFFFFF; border-radius: 4px; }
/* Toggle switch (HV md: 36×20, white handle, orange when on) */
html .track { width: 36px; height: 20px; border-radius: 10px; background: rgb(var(--hv-contrast) / .21); }
html .knob { width: 16px; height: 16px; top: 2px; left: 2px; background: #FFFFFF; }
html .toggle.on .knob { left: 18px; background: #FFFFFF; }
/* Notes */
html .danger-note, html .simple-warn, html .landing .note { border-radius: 8px; }
""",
'board-blueprint-studio.html': """
html body { font-family: var(--ui); }
/* Buttons: 4px radius; primary = HV Primary (orange, white text) */
html button, html details.menu > summary { border-radius: 4px; }
html button.primary { background: rgb(var(--hv-brand)); border-color: rgb(var(--hv-brand)); color: #FFFFFF; }
html button.primary:hover { background: rgb(var(--hv-brand-hover)); border-color: rgb(var(--hv-brand-hover)); color: #FFFFFF; }
/* Inputs */
html input[type=text], html input[type=number], html input[type=date], html select, html textarea { border-radius: 4px; }
html input:focus, html select:focus, html textarea:focus { border-color: rgb(var(--hv-info)); }
/* Section titles: sentence case, text color (HV titles), Noto Sans */
html h3 { font-size: 14px; line-height: 20px; font-weight: 700; letter-spacing: 0; text-transform: none; color: rgb(var(--hv-text)); }
html .grpname, html .libcat { font: 600 12px var(--ui); letter-spacing: 0; text-transform: none; color: rgb(var(--hv-text-3)); }
html dialog h2 { color: rgb(var(--hv-text)); font-size: 18px; }
/* Tabs: HV 1-depth tab — underline, no box */
html .tabs button { border-radius: 0; font-size: 13px; background: transparent; }
html .tabs button[aria-selected=true] { background: transparent; color: rgb(var(--hv-text)); box-shadow: inset 0 -2px 0 rgb(var(--hv-brand)); }
/* Segmented view switch + tool strip: HV button group / icon buttons */
html .vseg { border-radius: 4px; }
html .vseg button { border-radius: 4px; }
html .vseg button[aria-pressed=true] { background: rgb(var(--hv-contrast) / .14); color: rgb(var(--hv-text)); box-shadow: none; }
html .tools button { border-radius: 4px; }
html .tools button[aria-pressed=true] { background: rgb(var(--hv-brand) / .15); color: rgb(var(--hv-brand-fg)); box-shadow: none; }
/* Containers */
html dialog { border-radius: 8px; box-shadow: 0 8px 24px rgb(0 0 0 / var(--hv-shadow-3, .48)); }
html dialog::backdrop { background: rgb(0 0 0 / .5); }
html details.menu .items, html .viewbox { border-radius: 8px; }
""",
}

def apply_layer(s, name):
    css = LAYERS.get(name)
    if not css: return s
    block = f'<style id="hv-layer">{HV_BASE}{css}</style>\n'
    s = re.sub(r'<style id="hv-layer">.*?</style>\n?', '', s, flags=re.S)   # replace an older layer
    i = s.index('</head>')
    return s[:i] + block + s[i:]

MARK = '<!-- hv-theme -->'

def head_block():
    tokens = (FE / 'src/theme/hv-tokens.css').read_text()
    fonts = '\n'.join(
        f"@font-face {{ font-family: 'Noto Sans'; font-style: normal; font-display: swap; font-weight: {w}; "
        f"src: url('/hv-fonts/noto-sans-{s}-{w}-normal.woff2') format('woff2'); unicode-range: {r}; }}"
        for w in (400, 500, 600, 700) for s, r in (
            ('latin-ext', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'),
            ('latin', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD')))
    follow = """(function () {
  function read() {
    var t = null;
    try { t = window.parent && window.parent !== window ? window.parent.document.documentElement.dataset.theme : null; } catch (e) {}
    if (!t) { try { t = localStorage.getItem('hv-theme'); } catch (e) {} }
    document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
  }
  read();
  window.addEventListener('storage', function (e) { if (e.key === 'hv-theme') read(); });
  try { if (window.parent && window.parent !== window) window.parent.addEventListener('hv-theme', read); } catch (e) {}
})();"""
    return (f"{MARK}\n<script>{follow}</script>\n<style id=\"hv-tokens\">\n{tokens}\n{fonts}\n"
            ":root[data-theme=\"light\"] { --hv-shadow-1: 0.12; --hv-shadow-2: 0.12; --hv-shadow-3: 0.16; }\n</style>\n")

def map_root(s, mapping):
    """Rewrite '--name: value;' declarations inside the page's first :root { ... } rule."""
    m = re.search(r':root\s*\{', s)
    if not m: raise SystemExit('no :root block')
    a = m.end(); depth = 1; i = a
    while depth:
        depth += {'{': 1, '}': -1}.get(s[i], 0); i += 1
    block = s[a:i - 1]
    for k, v in mapping.items():
        block, n = re.subn(r'(%s\s*:\s*)[^;]*;' % re.escape(k), lambda mm: mm.group(1) + v + ';', block, count=1)
        if n != 1: raise SystemExit(f'{k} not found in :root')
    return s[:a] + block + s[i - 1:]

def convert_styles(s, mode='all'):
    def conv(css):
        if mode == 'all': return hvc.convert_text(css)
        # rgba-only: hide hex colors from the converter, convert, then put them back
        keep = []
        def hide(mm): keep.append(mm.group(0)); return f'\x00{len(keep) - 1}\x00'
        tmp = re.sub(r'#[0-9A-Fa-f]{3,8}(?![0-9A-Za-z_])', hide, css)
        return re.sub(r'\x00(\d+)\x00', lambda mm: keep[int(mm.group(1))], hvc.convert_text(tmp))
    def one(m):
        css = m.group(2)
        if MARK in s[max(0, m.start() - 200):m.start()] and 'hv-tokens' in m.group(1): return m.group(0)
        if '@font-face' in css and ':root' not in css and '{' in css and 'src:' in css and css.count('@font-face') > 3:
            return m.group(0)   # Google-font face blocks
        return m.group(1) + conv(css) + m.group(3)
    return re.sub(r'(<style\b[^>]*>)(.*?)(</style>)', one, s, flags=re.S)

def main():
    apply = '--apply' in sys.argv
    for name, mapping in PAGES.items():
        p = FE / 'public' / name; s = p.read_text(encoding='utf-8'); orig = s
        if MARK in s:
            ns = apply_layer(s, name)
            if ns != s:
                print(f"  {'layered' if apply else 'would layer'}  {name}")
                if apply: p.write_text(ns, encoding='utf-8')
            else:
                print(f'  already in   {name}')
            continue
        s = map_root(s, mapping)
        for page, old, new in EXTRA:
            if page == name:
                if old not in s: raise SystemExit(f'{name}: rule not found: {old[:50]}')
                s = s.replace(old, new, 1)
        if name in CONVERT_STYLE_BLOCKS: s = convert_styles(s, CONVERT_STYLE_BLOCKS[name])
        i = s.index('<style')                       # tokens go before the page's own styles
        s = s[:i] + head_block() + s[i:]
        s = apply_layer(s, name)
        print(f"  {'themed' if apply else 'would theme'}  {name}  ({sum(1 for a, b in zip(orig, s) if a != b) and 'changed'})")
        if apply: p.write_text(s, encoding='utf-8')

if __name__ == '__main__':
    main()
