#!/usr/bin/env python3
"""Wire Event Trace into an Aether tree by landmarks.   AETHER_TRACE

  python3 integrate_trace.py <aether folder> [--check]

Idempotent: every insert carries the AETHER_TRACE marker and is skipped when present.
--check only reports what would change and exits 1 if a required landmark is missing.
"""
import os
import re
import sys

MARK = 'AETHER_TRACE'


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def write(p, s):
    st = os.stat(p)
    tmp = p + '.trace-tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(s)
    os.chmod(tmp, st.st_mode & 0o7777)
    try:
        os.chown(tmp, st.st_uid, st.st_gid)   # keep the owner (the installer may run as root)
    except PermissionError:
        pass
    os.replace(tmp, p)


class Plan:
    def __init__(self, root, check):
        self.root, self.check = root, check
        self.missing, self.done, self.skipped, self.notes = [], [], [], []

    def path(self, rel):
        return os.path.join(self.root, rel)

    def edit(self, rel, name, fn, required=True):
        p = self.path(rel)
        if not os.path.exists(p):
            (self.missing if required else self.notes).append(f'{rel}: file not found ({name})')
            return
        s = read(p)
        try:
            out = fn(s)
        except LookupError as e:
            (self.missing if required else self.notes).append(f'{rel}: {name}: {e}')
            return
        if out is None or out == s:
            self.skipped.append(f'{rel}: {name} (already there)')
            return
        if not self.check:
            write(p, out)
        self.done.append(f'{rel}: {name}')


def insert_after_line(s, pattern, line, first=True):
    lines = s.split('\n')
    idx = [i for i, l in enumerate(lines) if re.search(pattern, l)]
    if not idx:
        raise LookupError(f'landmark not found: {pattern}')
    i = idx[0] if first else idx[-1]
    lines.insert(i + 1, line)
    return '\n'.join(lines)


def insert_before_line(s, pattern, line):
    lines = s.split('\n')
    idx = [i for i, l in enumerate(lines) if re.search(pattern, l)]
    if not idx:
        raise LookupError(f'landmark not found: {pattern}')
    lines.insert(idx[0], line)
    return '\n'.join(lines)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = sys.argv[1]
    check = '--check' in sys.argv
    P = Plan(root, check)

    # ── backend/server.js ────────────────────────────────────────────────
    def server_json(s):
        if "app.use('/api/trace', express.json(" in s:
            return None
        return insert_before_line(s, r"^app\.use\(express\.json\(\)\);",
                                  "app.use('/api/trace', express.json({ limit: '20mb' }));   // AETHER_TRACE (wire imports are larger than the global 100 kB limit)")
    P.edit('backend/server.js', 'JSON limit for /api/trace', server_json)

    def server_mount(s):
        if "require('./routes/trace')()" in s:
            return None
        line = "try { app.use('/api/trace', require('./routes/trace')()); } catch (e) { console.warn('[Trace] not mounted:', e.message); }   // AETHER_TRACE"
        try:
            return insert_after_line(s, r"require\('\./routes-analytics'\)\(\)", line)
        except LookupError:
            return insert_after_line(s, r"require\('\./routes/traffic'\)\(\)", line)
    P.edit('backend/server.js', 'mount /api/trace', server_mount)

    def server_attach(s):
        if "getEngine().attach(" in s:
            return None
        line = ("try { require('./routes/trace').getEngine().attach({ getWiegand: () => wiegandManager, getOsdp: () => osdpManager, "
                "emulator: require('./osdp/OSDPDeviceEmulator') }); } catch (e) { console.warn('[Trace] not attached:', e.message); }   // AETHER_TRACE")
        return insert_after_line(s, r"journal not attached", line)
    P.edit('backend/server.js', 'attach Event Trace after the journal', server_attach)

    # ── routes-oncafe.js: share the session helpers (no behaviour change) ──
    def oncafe(s):
        if 'module.exports.api = api' in s:
            return None
        if 'async function api(' not in s or 'function status(' not in s:
            raise LookupError('api()/status() not found')
        return s.rstrip('\n') + '\nmodule.exports.api = api; module.exports.status = status;   // AETHER_TRACE: Event Trace reuses the OnCAFE sign-in\n'
    P.edit('backend/routes-oncafe.js', 'export OnCAFE session helpers', oncafe)

    # ── routes/traffic.js: let Event Trace see flows (optional) ───────────
    def traffic(s):
        if 'module.exports.current = mgr' in s:
            return None
        return insert_after_line(s, r"const mgr = new TrafficManager\(\);", "  module.exports.current = mgr;   // AETHER_TRACE: Event Trace reads controller flows")
    P.edit('backend/routes/traffic.js', 'expose the Traffic Inspector to Event Trace', traffic, required=False)

    # ── journal: OSDP cards carry facility + card number (optional) ───────
    def journal(s):
        old = "record('card', `osdp:${args[0]}`, 1, 'osdp', { format: args[2] });"
        if 'fc: args[1] && args[1].facility' in s:
            return None
        if old not in s:
            raise LookupError('OSDP card hook not found')
        return s.replace(old, "record('card', `osdp:${args[0]}`, 1, 'osdp', { format: args[2], fc: args[1] && args[1].facility, cn: args[1] && args[1].card /* AETHER_TRACE */ });")
    P.edit('backend/analytics/journal.js', 'OSDP card numbers in the journal', journal, required=False)

    # ── frontend: Tools › Event Trace ────────────────────────────────────
    cs = 'frontend/src/components/ConfigSection.tsx'

    def fe_import(s):
        if "from './trace/EventTrace'" in s:
            return None
        line = "import EventTrace from './trace/EventTrace';   // AETHER_TRACE"
        try:
            return insert_after_line(s, r"^import TrafficInspector from", line)
        except LookupError:
            return insert_after_line(s, r"^import ", line, first=False)
    P.edit(cs, 'import EventTrace', fe_import)

    def fe_tab(s):
        if "id: 'trace'" in s:
            return None
        entry = ("  { id: 'trace', label: 'Event Trace', description: 'Follow every card from Aether through the controller and the wire to OnCAFE, live — "
                 "clock sync, latency per hop, credential checks' },   // AETHER_TRACE")
        m = re.search(r"export const TOOL_TABS = \[(.*?)\n\] as const;", s, re.S)
        if not m:
            raise LookupError('TOOL_TABS not found')
        block = m.group(0)
        lines = block.split('\n')
        at = next((i for i, l in enumerate(lines) if "id: 'traffic'" in l), len(lines) - 2)
        prev = lines[at]
        if not re.search(r",\s*(//.*)?$", prev) and not prev.rstrip().endswith('['):
            code, sep, comment = prev.partition('//')
            lines[at] = code.rstrip() + ',' + ((' ' * 3 + '//' + comment) if sep else '')
        lines.insert(at + 1, entry)
        return s.replace(block, '\n'.join(lines))
    P.edit(cs, 'Tools menu entry', fe_tab)

    def fe_render(s):
        if '<EventTrace' in s:
            return None
        line = "      {mode === 'tools' && page === 'trace' && <EventTrace />}{/* AETHER_TRACE */}"
        try:
            return insert_after_line(s, r"page === 'traffic' && <TrafficInspector", line)
        except LookupError:
            return insert_after_line(s, r"mode === 'tools' && page === '", line)
    P.edit(cs, 'render the page', fe_render)

    for x in P.done:
        print(('would change ' if check else 'changed ') + x)
    for x in P.skipped:
        print('ok ' + x)
    for x in P.notes:
        print('note ' + x)
    for x in P.missing:
        print('MISSING ' + x)
    return 1 if P.missing else 0


if __name__ == '__main__':
    sys.exit(main())
