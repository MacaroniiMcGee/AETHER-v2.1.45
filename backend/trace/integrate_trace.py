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
        line = ("try { require('./routes/trace').getEngine().attach({ gpioQueue, getWiegand: () => wiegandManager, getOsdp: () => osdpManager, "
                "emulator: require('./osdp/OSDPDeviceEmulator') }); } catch (e) { console.warn('[Trace] not attached:', e.message); }   // AETHER_TRACE")
        if "getEngine().attach({ gpioQueue," in s:
            return None
        if "getEngine().attach(" in s:   # TRACE-1 line: add the relay board for pulse sync markers
            return '\n'.join(line if 'getEngine().attach(' in l else l for l in s.split('\n'))
        return insert_after_line(s, r"journal not attached", line)
    P.edit('backend/server.js', 'attach Event Trace after the journal', server_attach)

    # ── routes-oncafe.js: share the session helpers (no behaviour change) ──
    def oncafe(s):
        full = 'module.exports.api = api; module.exports.status = status; module.exports.bearer = bearer;   // AETHER_TRACE: Event Trace reuses the OnCAFE sign-in'
        if 'module.exports.bearer = bearer' in s:
            return None
        if 'module.exports.api = api' in s:   # TRACE-1 line
            if 'async function bearer(' not in s:
                raise LookupError('bearer() not found')
            return '\n'.join(full if 'module.exports.api = api' in l else l for l in s.split('\n'))
        if 'async function api(' not in s or 'function status(' not in s or 'async function bearer(' not in s:
            raise LookupError('api()/status()/bearer() not found')
        return s.rstrip('\n') + '\n' + full + '\n'
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

    # ── TRACE-3: Doors page pairing ─────────────────────────────────────
    def server_door_activity(s):
        if 'getEngine().onDoorActivity(' in s:
            return None
        old = "io.emit('door_activity', entry);"
        if old not in s:
            raise LookupError('doorActivity emit not found')
        return s.replace(old, old + " try { require('./routes/trace').getEngine().onDoorActivity(entry, meta); } catch (_) { /* AETHER_TRACE */ }", 1)
    P.edit('backend/server.js', 'door activity into Event Trace', server_door_activity, required=False)

    def server_door_save(s):
        if 'getEngine().importDoors(' in s:
            return None
        line = ("app.post('/api/doors/config', (req, res, next) => { res.on('finish', () => { if (res.statusCode < 300) { try { require('./routes/trace').getEngine().importDoors('doors page'); } "
                "catch (e) { console.warn('[Trace] door import:', e.message); } } }); next(); });   // AETHER_TRACE: a door save updates the wiring map")
        return insert_before_line(s, r"^app\.use\('/api/doors', require\('\./routes-doors'\)\(\)\);", line)
    P.edit('backend/server.js', 'door saves update the wiring map', server_door_save, required=False)

    def analytics_keys(s):
        if 'AETHER_TRACE wiring keys' in s:
            return None
        old = "...(v.label ? { label: String(v.label).slice(0, 60) } : {}) };"
        if old not in s:
            raise LookupError('wiring validation not found')
        new = ("...(v.label ? { label: String(v.label).slice(0, 60) } : {}), "
               "...(v.note ? { note: String(v.note).slice(0, 300) } : {}), ...(/^door:\\d+$/.test(String(v.src || '')) ? { src: String(v.src) } : {}), "
               "...(Number(v.at) > 0 ? { at: Number(v.at) } : {}), ...(v.dir === 'in' || v.dir === 'out' ? { dir: v.dir } : {}), "
               "...(v.doorName ? { doorName: String(v.doorName).slice(0, 60) } : {}) };   /* AETHER_TRACE wiring keys: keep Doors page pairing */")
        return s.replace(old, new, 1)
    P.edit('backend/routes-analytics.js', 'Product Test keeps the door pairing in the wiring map', analytics_keys, required=False)

    ds = 'frontend/src/components/DoorSection.tsx'
    def ds_import(s):
        if "from './trace/DoorTrace'" in s:
            return None
        return insert_after_line(s, r"from '\.\./lib/workflowBridge';", "import { DoorTraceStrip } from './trace/DoorTrace';   // AETHER_TRACE")
    P.edit(ds, 'import the door trace strip', ds_import, required=False)

    def ds_save(s):
        if 'trace: (door as any).trace' in s:
            return None
        old = "        reader: door.reader ?? null,\n        customEvents: door.customEvents\n      }))"
        if old not in s:
            raise LookupError('door save mapping not found')
        return s.replace(old, "        reader: door.reader ?? null,\n        customEvents: door.customEvents,\n        trace: (door as any).trace   // AETHER_TRACE: OnCAFE pairing + description\n      }))", 1)
    P.edit(ds, 'save the door pairing with the door', ds_save, required=False)

    def ds_strip(s):
        if '<DoorTraceStrip' in s:
            return None
        return insert_before_line(s, r"\{/\* AETHER_DOOR_ACTIVITY: what happened on this door's I/O and reader \*/\}",
                                  "        <DoorTraceStrip doorId={door.id} />{/* AETHER_TRACE */}\n")
    P.edit(ds, 'Event Trace strip on each door', ds_strip, required=False)

    dset = 'frontend/src/components/DoorSettings.tsx'
    def dset_import(s):
        if "from './trace/DoorTrace'" in s:
            return None
        return insert_after_line(s, r"^import .*;\s*(//.*)?$", "import { DoorTracePairing } from './trace/DoorTrace';   // AETHER_TRACE", first=False)
    P.edit(dset, 'import the door pairing', dset_import, required=False)

    def dset_pairing(s):
        if '<DoorTracePairing' in s:
            return None
        mark = 'This reader is used for presenting credentials to this door (single reader per door).'
        i = s.find(mark)
        if i < 0:
            raise LookupError('reader card not found')
        j = s.find('\n              </div>\n', i)
        if j < 0:
            raise LookupError('end of the reader card not found')
        j += len('\n              </div>\n')
        block = ("\n              {/* AETHER_TRACE: pair with the OnCAFE door + description (Event Trace) */}\n"
                 "              <DoorTracePairing door={editedDoor as any} onChange={(trace: any) => setEditedDoor({ ...(editedDoor as any), trace } as any)} />\n")
        return s[:j] + block + s[j:]
    P.edit(dset, 'OnCAFE door + description in Settings › Basic', dset_pairing, required=False)

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
