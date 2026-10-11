#!/usr/bin/env python3
"""
HV artwork restore — drawings keep their real-world colors in both themes.

The HV theme is for the interface (panels, text, buttons). Illustrations of
physical things — the door scene, reader hardware, elevator cab, switch
faceplate — must not follow the theme: a wooden door, a white hallway or a
black reader housing do not invert in Light mode. hv-convert.py recolored
those drawings with theme tokens, which inverted them in Light mode (and
broke the elevator's url(#cab-…) gradient links, read as a hex color).

This script restores the original colors on artwork lines only, taking them
from the pre-HV source (git commit BASE). A line is restored only when it
differs from the original *only in colors*; any other edit keeps the current
line. Interface lines (anything with className=) are left themed.

    python3 scripts/hv-artwork.py [--apply]       (run from frontend/)
"""
import difflib
import re
import subprocess
import sys
from pathlib import Path

BASE = 'da99f8f'          # Pi snapshot 2026-10-07 11:58, before the HV conversion
ROOT = Path(__file__).resolve().parent.parent

ART = re.compile(r'fill=|stroke=|stopColor|<stop|els\.push|gradient\(|drop-shadow|@keyframes|^\s*\d+%')
FILES = {
    # whole component is the device illustration
    'src/components/InteractiveReader.tsx': lambda l, at: True,
    'src/components/InteractiveWiegandReader.tsx': lambda l, at: True,
    # the scene, not the event list / labels around it
    'src/components/DoorAnimation.tsx': lambda l, at: 'className=' not in l,
    # car operating panel (display, card reader, floor/door/alarm buttons), the shaft and the cab
    'src/components/ElevatorSection.tsx': lambda l, at: at('── Car operating panel ──', '── Hoistway ──')
        or at('shaft: one cell for all floors', '<CarCab ') or (bool(ART.search(l)) and 'linear-gradient(160deg' not in l),
    # port faceplate drawing
    # (its traffic chart's axes and grid are interface and stay themed)
    'src/components/SwitchSection.tsx': lambda l, at: bool(re.search(r'fill=|stroke=|stopColor|<stop|linear-gradient\(180deg|inset 0 -12px', l))
        and not re.search(r'<text|<line ', l),
}

COLOR = re.compile(
    r'color-mix\(in srgb,[^()]*(?:\([^()]*(?:\([^()]*\))?[^()]*\))?[^()]*\)'   # color-mix(…)
    r'|rgba?\(var\(--hv-[a-z0-9-]+\)(?:\s*/\s*[\d.]+)?\)'                      # rgb(var(--hv-x) / a)
    r'|rgba?\([\d\s.,/%]+\)'                                                    # rgb(…) literal
    r'|#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])'                                      # hex
    r'|#[0-9a-fA-F]{3}(?=-)'                                                    # hex-looking id (#cab-wall)
    r'|\$\{[A-Za-z.]+\}[0-9a-fA-F]{2}(?![0-9a-zA-Z])')                          # ${C.x}55 alpha suffix


def skeleton(line):
    return COLOR.sub('§', line)


def restore(rel, keep, apply):
    path = ROOT / rel
    cur = path.read_text().splitlines(keepends=True)
    old = subprocess.run(['git', 'show', f'{BASE}:frontend/{rel}'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines(keepends=True)
    out, n = [], 0

    def region(j):
        def at(start, end):
            a = next((k for k, x in enumerate(cur) if start in x), None)
            b = next((k for k, x in enumerate(cur) if end in x and a is not None and k > a), None)
            return a is not None and b is not None and a <= j <= b
        return at
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=old, b=cur, autojunk=False).get_opcodes():
        if op == 'replace' and (i2 - i1) == (j2 - j1):
            for k, (o, c) in enumerate(zip(old[i1:i2], cur[j1:j2])):
                if keep(c, region(j1 + k)) and skeleton(o) == skeleton(c):
                    out.append(o); n += 1
                else:
                    out.append(c)
        else:
            out.extend(cur[j1:j2])
    new = ''.join(out)
    print(f'  {rel}: {n} artwork lines restored')
    if apply and new != ''.join(cur):
        path.write_text(new)


if __name__ == '__main__':
    apply = '--apply' in sys.argv
    for rel, keep in FILES.items():
        restore(rel, keep, apply)
