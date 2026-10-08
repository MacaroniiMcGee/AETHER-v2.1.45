#!/usr/bin/env python3
"""Wire Device firmware into an Aether folder.  integrate.py <aether folder>

Idempotent and anchor-based, so it fits copies that have drifted from GitHub:
  backend/server.js                         mount /api/device-firmware after app.use(express.json())
  frontend/src/components/IOAccessEmulator  Tools tab: a "Device firmware" card + its panel
  frontend/src/App.tsx                      /firmware route (also works if the Tools tab can't be patched)
Prints one line per step; exits 1 only if the backend mount fails.
"""
import re, sys, os

root = sys.argv[1] if len(sys.argv) > 1 else '.'
P = lambda *a: os.path.join(root, *a)
ok = True

def rd(p):
    with open(p, encoding='utf-8', errors='surrogateescape') as f: return f.read()
def wr(p, s):
    with open(p + '.fwtmp', 'w', encoding='utf-8', errors='surrogateescape') as f: f.write(s)
    os.replace(p + '.fwtmp', p)

# ---- backend mount
p = P('backend', 'server.js')
s = rd(p)
if 'routes-device-firmware' in s:
    print('  already in   backend mount')
else:
    m = re.search(r"^app\.use\(express\.json\([^)]*\)\);[^\n]*\n", s, re.M) or re.search(r"^const io = new Server\([^\n]*\n", s, re.M)
    if not m:
        print('  FAILED       backend mount (no app.use(express.json()) line in server.js)'); ok = False
    else:
        add = ("// Device firmware: send Aether updates and script files from the browser\n"
               "try { app.use('/api/device-firmware', require('./routes-device-firmware')()); } "
               "catch (e) { console.warn('[DeviceFirmware] not mounted:', e.message); }\n")
        s = s[:m.end()] + add + s[m.end():]
        wr(p, s); print('  applied      backend mount')

# ---- Tools tab
p = P('frontend', 'src', 'components', 'IOAccessEmulator.tsx')
CARD = """
                <button
                  onClick={() => setActiveToolsTab('firmware')}
                  className={`p-6 rounded-lg border-2 transition-all text-left ${
                    activeToolsTab === 'firmware'
                      ? 'border-[#E8915A] bg-gradient-to-br from-[#E8915A]/15 to-[#E8915A]/5 shadow-lg shadow-[#E8915A]/20'
                      : 'border-[#38302A] bg-[#241E19]/50 hover:border-[#4A3F36]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <FirmwareIcon className={`w-8 h-8 ${activeToolsTab === 'firmware' ? 'text-[#E8915A]' : 'text-[#786D60]'}`} />
                    <span className="px-2 py-1 bg-[#E8915A]/15 text-[#F2B48A] text-xs rounded-full border border-[#E8915A]/30">
                      Updates
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">Device Firmware</h3>
                  <p className="text-sm text-[#ADA294]">Send updates and scripts</p>
                  <div className="mt-3 text-xs text-[#786D60]">Bundles | Files | Rollback</div>
                </button>"""
PANEL = "            {activeToolsTab === 'firmware' && <DeviceFirmwareTool backendUrl={`http://${ipAddress}:3001`} />}\n"
if not os.path.exists(p):
    print('  skipped      Tools tab (IOAccessEmulator.tsx not found; use /firmware)')
else:
    s = rd(p)
    if "DeviceFirmwareTool" in s:
        print('  already in   Tools tab')
    else:
        steps = []
        # imports, after the last import line
        imps = list(re.finditer(r"^import [^\n]*;[ \t]*\n", s, re.M))
        st = re.search(r"(const \[activeToolsTab, setActiveToolsTab\] = useState<)([^>]*)(>)", s)
        cards = list(re.finditer(r"onClick=\{\(\) => setActiveToolsTab\('[\w-]+'\)\}", s))
        panels = list(re.finditer(r"^[ \t]*\{activeToolsTab === '[\w-]+' && ", s, re.M))
        if not (imps and st and cards and panels):
            print('  skipped      Tools tab (layout not recognised; use /firmware)')
        else:
            # work from the end of the file backwards so earlier offsets stay valid
            # 1. panel before the first panel block
            i = panels[0].start(); s = s[:i] + PANEL + s[i:]
            # 2. card after the button holding the last setActiveToolsTab(...) click
            last = cards[-1]
            close = s.find('</button>', last.end())
            if close < 0:
                print('  skipped      Tools tab (no card button found; use /firmware)')
                s = None
            else:
                close += len('</button>'); s = s[:close] + CARD + s[close:]
                # 3. one more grid column (the grid holding the first card)
                first = re.search(r"onClick=\{\(\) => setActiveToolsTab\('[\w-]+'\)\}", s)
                g = list(re.finditer(r"grid-cols-(\d)", s[:first.start()]))
                if g:
                    n = int(g[-1].group(1)); s = s[:g[-1].start()] + f"grid-cols-{min(n + 1, 5)}" + s[g[-1].end():]
                # 4. state type
                s = re.sub(r"(const \[activeToolsTab, setActiveToolsTab\] = useState<)([^>]*)(>)",
                           lambda m: m.group(1) + m.group(2) + "|'firmware'" + m.group(3), s, count=1)
                # 5. imports
                imps = list(re.finditer(r"^import [^\n]*;[ \t]*\n", s, re.M))
                j = imps[-1].end()
                s = s[:j] + "import DeviceFirmwareTool from './DeviceFirmwareTool';\nimport { UploadCloud as FirmwareIcon } from 'lucide-react';\n" + s[j:]
                wr(p, s); print('  applied      Tools tab card')

# ---- /firmware route
p = P('frontend', 'src', 'App.tsx')
if not os.path.exists(p):
    print('  skipped      /firmware route (App.tsx not found)')
else:
    s = rd(p)
    if 'DeviceFirmwareTool' in s:
        print('  already in   /firmware route')
    else:
        r = list(re.finditer(r"^([ \t]*)<Route path=[^\n]*/>[ \t]*\n", s, re.M))
        imps = list(re.finditer(r"^import [^\n]*;?[ \t]*\n", s, re.M))
        if not (r and imps):
            print('  skipped      /firmware route (no <Route> found)')
        else:
            ind = r[-1].group(1)
            route = (f"{ind}{{/* Device firmware on its own page: http://<pi>:<port>/firmware */}}\n"
                     f"{ind}<Route path=\"/firmware\" element={{<div className=\"min-h-screen p-6\" style={{{{ background: '#14100E' }}}}><div className=\"max-w-[1400px] mx-auto\">"
                     f"<DeviceFirmwareTool backendUrl={{`${{window.location.protocol}}//${{window.location.hostname}}:3001`}} /></div></div>}} />\n")
            k = r[-1].end(); s = s[:k] + route + s[k:]
            j = imps[-1].end(); s = s[:j] + "import DeviceFirmwareTool from './components/DeviceFirmwareTool'\n" + s[j:]
            wr(p, s); print('  applied      /firmware route')

sys.exit(0 if ok else 1)
