#!/usr/bin/env python3
"""
HV pastel pass — off-guideline solid fills become light tints.

The HV GUI Guidelines use exactly two saturated fills on controls: Brand
(orange, primary action) and Error (red, destructive action). Everything else
that carries a label — chips, badges, toggles, selected options, secondary
action buttons — is a light tint of its color with a colored border and
readable text.

This pass finds solid fills of any other color on *labeled* elements and
converts them:

    bg-hv-success-strong            ->  bg-hv-success-tint text-hv-success-fg ring-1 ring-inset ring-hv-success/40
    hover:bg-hv-success-hover       ->  hover:bg-hv-success-tint-strong
    bg-hv-data-indigo               ->  bg-hv-data-indigo-tint text-hv-text ring-1 ring-inset ring-hv-data-indigo/40
    bg-blue-600 (legacy family)     ->  same, via the family's HV token

White / near-black label text in the same class string is dropped so the
tint's text color shows. Small marks with no label (status dots, progress
bars, LEDs) keep their solid color — they need the saturation to be seen.

Brand, error, red, rose and orange fills are guideline colors and are left
alone. Runs over src/**/*.tsx|ts; idempotent.

    python3 scripts/hv-pastel.py [--dry]
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'

LEGACY = {
    'green': ('st', 'success'), 'emerald': ('st', 'success'),
    'blue': ('st', 'info'),
    'amber': ('st', 'warning'), 'yellow': ('st', 'warning'),
    'purple': ('purple', 'purple'),
    'lime': ('data', 'green'),
    'sky': ('data', 'sapphire'), 'cyan': ('data', 'sapphire'), 'teal': ('data', 'sapphire'),
    'indigo': ('data', 'indigo'),
    'violet': ('data', 'violet'), 'fuchsia': ('data', 'violet'),
    'pink': ('data', 'pink'),
}
HV = {
    'success': 'success', 'success-strong': 'success', 'success-hover': 'success',
    'info': 'info', 'info-strong': 'info', 'info-text': 'info',
    'warning': 'warning', 'warning-text': 'warning',
}
DATA = ['blue', 'coral', 'emerald', 'gray', 'green', 'indigo', 'orange', 'pink',
        'purple', 'red', 'sapphire', 'violet', 'yellow']

NAME = (r'hv-(?:success-strong|success-hover|success|info-strong|info-text|info|warning-text|warning'
        r'|purple|pink|violet|data-(?:' + '|'.join(DATA) + r'))'
        r'|(?:' + '|'.join(LEGACY) + r')-[3-7]00')
TOKEN = re.compile(r'(?<![\w\[-])((?:[a-z-]+:)*)bg-(' + NAME + r')(?![\w/-])')
KEPT_SOLID = re.compile(r'(?<![\w:\[-])bg-(?:hv-(?:brand|brand-hover|error|error-strong|error-hover)|(?:red|rose|orange)-[4-7]00)(?![\w/-])')
LABELED = re.compile(r'(?<![\w-])(?:p|px|py|pl|pr|pt|pb)-[\d.\[]|(?<![\w-])text-(?:xs|sm|base|lg|xl|2xl|\[\d)|(?<![\w-])font-')
ON_TEXT = re.compile(r'(?<![\w:\[-])(?:(?:hover|group-hover|active):)?text-(?:white|black|\[#FFFFFF\]|\[#101011\])(?![\w/-])')


def drop_on_text(s):
    """Remove white/ink label text classes together with one neighbouring space."""
    s = re.sub(r' (?:' + ON_TEXT.pattern + ')', '', s)
    return re.sub('(?:' + ON_TEXT.pattern + ') ?', '', s)


def classify(name):
    if name.startswith('hv-data-'):
        return 'data', name[8:]
    if name.startswith('hv-'):
        n = name[3:]
        if n == 'purple':
            return 'purple', 'purple'
        if n in ('pink', 'violet'):
            return 'data', n
        return 'st', HV[n]
    fam = name.rsplit('-', 1)[0]
    return LEGACY[fam]


def base_classes(kind, fam):
    if kind == 'st':
        return f'bg-hv-{fam}-tint text-hv-{fam}-fg ring-1 ring-inset ring-hv-{fam}/40'
    if kind == 'purple':
        return 'bg-hv-purple-tint text-hv-purple-fg ring-1 ring-inset ring-hv-purple/40'
    return f'bg-hv-data-{fam}-tint text-hv-text ring-1 ring-inset ring-hv-data-{fam}/40'


def state_class(prefix, kind, fam):
    if kind == 'st':
        return f'{prefix}bg-hv-{fam}-tint-strong'
    if kind == 'purple':
        return f'{prefix}bg-hv-purple/25'
    return f'{prefix}bg-hv-data-{fam}/25'


def convert_region(s, notes):
    """Convert one class-string region (a className=… expression or a string constant)."""
    toks = list(TOKEN.finditer(s))
    if not toks or not LABELED.search(s):
        return s
    has_kept = bool(KEPT_SOLID.search(s))
    has_base = any(not m.group(1) for m in toks)
    out, last, converted_base = [], 0, False
    for m in toks:
        prefix, name = m.group(1), m.group(2)
        kind, fam = classify(name)
        if not prefix:
            rep = base_classes(kind, fam)
            converted_base = True
        elif has_base or not has_kept:
            rep = state_class(prefix, kind, fam)
        else:
            notes.append(f'left {prefix}bg-{name} (state on a guideline fill)')
            continue
        out.append(s[last:m.start()]); out.append(rep); last = m.end()
    out.append(s[last:])
    s = ''.join(out)
    # Option groups that mix meanings ('activate' green / 'deactivate' red / …): once one
    # branch is a tint, the brand/error branches of the same group become tints too.
    if converted_base:
        def branch(q):
            b = q.group(0)
            if LABELED.search(b):
                return b
            k = re.search(r'(?<![\w:\[-])bg-(hv-brand-hover|hv-brand|hv-error-strong|hv-error-hover|hv-error|(red|rose|orange)-[4-7]00)(?![\w/-])', b)
            if not k:
                return b
            fam = 'brand' if ('brand' in k.group(1) or 'orange' in k.group(1)) else 'error'
            b = b[:k.start()] + base_classes('st', fam) + b[k.end():]
            b = re.sub(r'(?<![\w\[-])((?:[a-z-]+:)+)bg-(hv-(?:brand|error)[a-z-]*|(?:red|rose|orange)-[3-7]00)(?![\w/-])',
                       lambda h: f'{h.group(1)}bg-hv-{fam}-tint-strong', b)
            return drop_on_text(b)
        s = re.sub(r"'[^'\n]*'", branch, s)
        has_kept = bool(KEPT_SOLID.search(s))
    # A tint inside its own quoted branch ('…') drops white/ink text from that branch.
    s = re.sub(r"'[^'\n]*-tint text-hv-[^'\n]*'|\"[^\"\n]*-tint text-hv-[^\"\n]*\"",
               lambda q: drop_on_text(q.group(0)), s)
    if converted_base and not has_kept:
        s = drop_on_text(s)
    elif converted_base and ON_TEXT.search(s):
        notes.append('mixed region (guideline fill + tint) kept its white/ink text — review')
    return s


def regions(text):
    """Yield (start, end) spans: className={…}/"…" expressions, then other string literals with bg-."""
    spans = []
    for m in re.finditer(r'className=', text):
        i = m.end()
        if i >= len(text):
            continue
        c = text[i]
        if c in '"\'':
            j = text.find(c, i + 1)
            if j > 0:
                spans.append((i, j + 1))
        elif c == '{':
            depth, j = 0, i
            while j < len(text):
                if text[j] == '{':
                    depth += 1
                elif text[j] == '}':
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            spans.append((i, j + 1))
    covered = []
    for a, b in spans:
        covered.append((a, b))
    def inside(p):
        return any(a <= p < b for a, b in covered)
    for m in re.finditer(r"'[^'\n]*\bbg-[^'\n]*'|\"[^\"\n]*\bbg-[^\"\n]*\"|`[^`\n]*\bbg-[^`\n]*`", text):
        if not inside(m.start()) and not inside(m.end() - 1) and 'className=' not in m.group(0):
            spans.append((m.start(), m.end()))
    return sorted(spans)


def process(path, dry):
    text = path.read_text()
    notes, out, last = [], [], 0
    for a, b in regions(text):
        if a < last:
            continue
        out.append(text[last:a]); out.append(convert_region(text[a:b], notes)); last = b
    out.append(text[last:])
    new = ''.join(out)
    if new != text:
        n = sum(1 for x, y in zip(text.splitlines(), new.splitlines()) if x != y)
        print(f'{path.relative_to(ROOT)}: {n} lines')
        for x in sorted(set(notes)):
            print(f'   note: {x}')
        if not dry:
            path.write_text(new)
    return new != text


if __name__ == '__main__':
    dry = '--dry' in sys.argv
    files = sorted(p for p in SRC.rglob('*') if p.suffix in ('.tsx', '.ts'))
    changed = sum(process(p, dry) for p in files)
    print(f'{changed} files {"would change" if dry else "changed"}')
