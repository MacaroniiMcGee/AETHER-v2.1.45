#!/usr/bin/env python3
"""Mock NHP controller for testing nhp_limits.py. NOT the real firmware.
Built-in limits (so the tests have something to find):
  Digest MD5 + SHA-256, nonce stale after 100 uses; Basic refused
  lockout after 5 consecutive wrong passwords for LOCK_S seconds
  max 12 concurrent requests (503), max 4 monitor streams, URL > 8192 -> 414
  accessschedule max 16 (client tokens), specialdaygroup max 8, accessgroup max 10 (device tokens)
  door control: max 5 commands / second
"""
import hashlib, json, os, re, ssl, sys, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK_S = float(os.environ.get("MOCK_LOCK_S", "12"))
USER, PW = "admin", "Passw0rd!"
REALM = "iPolis_00:09:18:AA:BB:CC"
nonces, nlock = {}, threading.Lock()
fails = {"n": 0, "until": 0}
active = threading.BoundedSemaphore(12)
monitors = threading.BoundedSemaphore(int(os.environ.get("MOCK_MONITORS", "4")))
door_times = []
store = {"accessschedule": {}, "specialdaygroup": {}, "accessgroup": {"1": {"Token": "1", "Name": "Everyone"}}, "accessprofile": {}}
MAXES = {"accessschedule": int(os.environ.get("MOCK_SCHED_MAX", "16")), "specialdaygroup": 1, "accessgroup": 10,
         "accessprofile": int(os.environ.get("MOCK_AP_MAX", "30"))}
door_state = {"1": {"unlock_until": 0, "mode": "Lock"}, "2": {"unlock_until": 0, "mode": "Lock"}}
DOORS = json.loads(open(os.path.join(os.path.dirname(__file__), "mock_doors.json")).read())
ATTR = open(os.path.join(os.path.dirname(__file__), os.environ.get("MOCK_ATTR", "mock_attributes.xml"))).read()


def now_iso():
    t = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t % 1 * 1000):03d}+00:00"


def all_states():
    out = []
    for t, s in door_state.items():
        accessed = time.time() < s["unlock_until"]
        mode = "Accessed" if accessed and s["mode"] == "Lock" else {"Lock": "Locked", "Unlock": "Unlocked",
                                                                  "LockDown": "LockedDown", "LockOpen": "LockedOpen"}.get(s["mode"], s["mode"])
        lock = "Unlocked" if mode in ("Accessed", "Unlocked", "LockedOpen") else "Locked"
        src = {"DoorToken": t}
        out += [{"EventName": "AccessControl.DoorMode", "Time": now_iso(), "Source": src, "Data": {"Mode": mode}},
                {"EventName": "AccessControl.LockPhysicalState", "Time": now_iso(), "Source": src, "Data": {"LockPhysicalState": lock}},
                {"EventName": "AccessControl.DoorPhysicalState", "Time": now_iso(), "Source": src, "Data": {"DoorPhysicalState": "Closed"}},
                {"EventName": "AccessControl.DoorAlarmState", "Time": now_iso(), "Source": src, "Data": {"Reason": "", "Status": "Normal"}}]
    for i, r in enumerate((0, 1, 2, 3)):
        out.append({"EventName": "AccessControl.CredentialReaderState", "Time": now_iso(),
                    "Source": {"IOPort": i // 2 + 1, "ReaderIndex": r}, "Data": {"State": "Active" if r % 2 == 0 else ""}})
    return out


def err(code, reason="invalid Parameter", details="Unknown Error"):
    return {"Response": "Fail", "Error": {"Code": code, "Details": details, "Reason": reason}}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, status, body, ctype="application/json", extra=None):
        b = body if isinstance(body, bytes) else (json.dumps(body) if not isinstance(body, str) else body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def challenge(self, stale=False):
        n = os.urandom(12).hex()
        with nlock:
            nonces[n] = {"t": time.time(), "uses": 0}
        s = ", stale=true" if stale else ""
        hs = [("WWW-Authenticate", f'Digest realm="{REALM}", qop="auth", nonce="{n}", algorithm=SHA-256{s}'),
              ("WWW-Authenticate", f'Digest realm="{REALM}", qop="auth", nonce="{n}", algorithm=MD5{s}')]
        self.send(401, "401 Unauthorized", "text/plain", hs)

    def auth(self):
        h = self.headers.get("Authorization", "")
        if not h.startswith("Digest "):
            self.challenge()
            return False
        d = {m.group(1).lower(): (m.group(3) if m.group(3) is not None else m.group(2))
             for m in re.finditer(r'([\w-]+)\s*=\s*("([^"]*)"|[^,\s]+)', h[7:])}
        if time.time() < fails["until"]:
            self.send(401, err("LOCKED", "account locked", "Too many failures"))
            return False
        with nlock:
            st = nonces.get(d.get("nonce"))
            if not st:
                pass
            else:
                st["uses"] += 1
        if not st or st["uses"] > 100 or time.time() - st["t"] > 300:
            self.challenge(stale=True)
            return False
        alg = d.get("algorithm", "MD5").upper()
        H_ = (lambda s: hashlib.sha256(s.encode()).hexdigest()) if alg == "SHA-256" else (lambda s: hashlib.md5(s.encode()).hexdigest())
        ha1 = H_(f"{d.get('username')}:{REALM}:{PW}")
        ha2 = H_(f"{self.command}:{d.get('uri')}")
        exp = H_(f"{ha1}:{d['nonce']}:{d.get('nc')}:{d.get('cnonce')}:auth:{ha2}")
        if d.get("username") != USER or d.get("response") != exp:
            fails["n"] += 1
            if fails["n"] >= 5:
                fails["until"] = time.time() + LOCK_S
                fails["n"] = 0
            self.challenge()
            return False
        fails["n"] = 0
        return True

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        self.do_GET()

    def do_GET(self):
        if len(self.path) > 8192:
            return self.send(414, "URI Too Long", "text/plain", [("Connection", "close")])
        if not active.acquire(blocking=False):
            return self.send(503, "Busy", "text/plain")
        try:
            self.route()
        finally:
            active.release()

    def route(self):
        u = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
        if not self.auth():
            return
        time.sleep(float(os.environ.get('MOCK_DELAY','0.01')))
        m = re.match(r"^/stw-cgi/(\w+)\.cgi(/.*)?$", u.path)
        if not m:
            return self.send(404, "Not Found", "text/plain")
        cgi = m.group(1)
        if cgi == "attributes":
            return self.send(200, ATTR, "application/xml")
        sub, act = q.pop("msubmenu", ""), q.pop("action", "")
        if cgi == "system" and sub == "deviceinfo" and act == "view":
            return self.send(200, {"Model": "NHP-P200", "DeviceType": "ACS", "FirmwareVersion": os.environ.get("MOCK_FW", "26.04.03_mock"),
                                   "SerialNumber": "MOCK0001", "ConnectedMACAddress": "00:09:18:AA:BB:CC"})
        if cgi == "eventstatus" and sub == "eventstatus" and act in ("monitor", "monitordiff"):
            return self.monitor()
        if cgi == "eventstatus" and sub == "eventstatus" and act == "check":
            return self.send(200, {"EventStatus": all_states()})
        if cgi == "system" and sub == "date" and act == "view":
            return self.send(200, {"LocalTime": time.strftime("%Y-%m-%dT%H:%M:%S"), "TimeZoneIndex": 22, "DSTEnable": True, "SyncType": "NTP"})
        if cgi == "eventsources" and sub == "alarminput" and act == "view":
            return self.send(200, {"AlarmInputs": [{"AlarmInput": i, "State": "NormallyOpen", "SupervisedCheck": False} for i in range(1, 9)]})
        if cgi == "accesscontrol" and sub == "credentialreader" and act == "view":
            return self.send(200, {"CredentialReaders": [{"Index": i, "Mode": "Wiegand", "BaudRate": 9600} for i in range(1, 3)]})
        if cgi != "accesscontrol":
            return self.send(200, err(608, "unknown cgi"))
        if sub == "capabilities" and act == "view":
            # real NHP-P400 layout (2026-11 CloudConnector log), mock-sized numbers
            return self.send(200, {"Capabilities": {
                "Door": {"MaxCount": 2}, "CredentialReader": {"MaxCount": 4},
                "AuthenticationProfile": {"MaxAuthenticationProfiles": 4, "MaxPoliciesPerAuthenticationProfile": 10},
                "Schedule": {"MaxCount": MAXES["accessschedule"], "MaxTimePeriodsPerDay": 100, "MaxSpecialDayGroups": 1, "SpecialDaysSupported": False},
                "AccessPoint": {"MaxCount": 4, "MaxAreas": 4},
                "AccessProfile": {"MaxCount": MAXES["accessprofile"], "MaxAccessPoliciesPerAccessProfile": 4, "MaxSchedulesPerAccessPolicy": 15},
                "AccessGroup": {"MaxCount": 10}, "CredentialMethod": {"MaxCount": 250000},
                "Credential": {"MaxCount": 250000, "MaxAccessProfilesPerCredential": 10, "MaxCredentialMethodsPerCredential": 250000,
                               "MaxGroupsPerCredential": 10, "SupportedIdentifierType": ["Card", "PIN"]}}})
        if sub == "hostcommunication" and act == "view":
            return self.send(200, {"HostCommunication": {"CloudConnectionState": os.environ.get("MOCK_CLOUD", "Disconnected"), "Enable": True}})
        if sub == "door":
            return self.door(act, q)
        if sub in store:
            return self.obj(sub, act, q)
        if sub in ("area", "accesspoint") and act == "view":
            return self.send(200, {"Areas" if sub == "area" else "AccessPoints": []})
        return self.send(200, err(608, "unknown submenu"))

    def dstate(self, t):
        s = door_state[t]
        unlocked = time.time() < s["unlock_until"] or s["mode"] in ("Unlock", "LockOpen")
        return {"Token": t, "LockState": "Unlocked" if unlocked else "Locked", "Mode": s["mode"], "DoorState": "Closed"}

    def door(self, act, q):
        if act == "view":
            if "Token" in q:
                ds = [d for d in DOORS["Doors"] if d["Token"] == q["Token"]]
                return self.send(200, {"Doors": ds} if ds else err(604, "token not found"))
            return self.send(200, DOORS)
        if act == "check":
            t = q.get("Token")
            if t not in door_state:
                return self.send(200, err(604, "token not found"))
            return self.send(200, {"DoorStatus": [self.dstate(t)]})
        if act == "control":
            if set(q) - {"Token", "Command"} or "Command" not in q or "Token" not in q or len(q["Token"]) > 32:
                return self.send(200, err(627))
            cmds = ["Access", "Lock", "Unlock", "LockDown", "LockDownRelease", "LockOpen", "LockOpenRelease"]
            if q["Command"] not in cmds:
                return self.send(200, err(627))
            if q["Token"] not in door_state:
                return self.send(200, err(604, "token not found"))
            now = time.time()
            door_times[:] = [t for t in door_times if now - t < 1] + [now]
            if len(door_times) > 5:
                return self.send(200, err(699, "busy", "Too many requests"))
            d = next(x for x in DOORS["Doors"] if x["Token"] == q["Token"])
            if not d["Capabilities"].get(q["Command"].replace("Release", ""), False):
                return self.send(200, err(650, "not supported"))
            s = door_state[q["Token"]]
            c = q["Command"]
            if c == "Access":
                s["unlock_until"] = now + d["Timings"]["ReleaseTime"]
            elif c in ("Lock", "LockDownRelease"):
                s["mode"], s["unlock_until"] = "Lock", 0
            else:
                s["mode"] = c
            return self.send(200, {"Response": "Success"})
        return self.send(200, err(609, "unknown action"))

    def obj(self, sub, act, q):
        st = store[sub]
        key = {"accessschedule": "AccessSchedules", "specialdaygroup": "SpecialDayGroups", "accessgroup": "AccessGroups", "accessprofile": "AccessProfiles"}[sub]
        if act == "view":
            return self.send(200, {key: list(st.values())})
        if act == "add":
            name = q.get("Name", "")
            lim = 64 if (sub == "accessschedule" and os.environ.get("MOCK_TRUNC", "1") == "1") else 32     # planted bug: accessschedule accepts 64, keeps 32
            if not name or len(name) > lim:
                return self.send(200, err(627))
            name = name[:32]
            if len(st) >= MAXES[sub]:
                return self.send(200, err(612, "max count reached", "Exceeds Max Limit"))
            if sub == "accessgroup":
                if "Token" in q:
                    return self.send(200, err(627))
                t = str(max(int(x) for x in st) + 1 if st else 1)
            else:
                t = q.get("Token", "")
                if not t or len(t) > 32 or t in st:
                    return self.send(200, err(627))
            st[t] = {"Token": t, "Name": name.strip(), "Description": q.get("Description", "")}
            return self.send(200, {"Response": "Success", "Token": t} if sub == "accessgroup" else {"Response": "Success"})
        if act == "remove":
            t = q.get("Token")
            if t not in st:
                return self.send(200, err(604, "token not found"))
            del st[t]
            return self.send(200, {"Response": "Success"})
        return self.send(200, err(609, "unknown action"))

    def monitor(self):
        if not monitors.acquire(blocking=False):
            return self.send(503, "Too many monitor sessions", "text/plain")
        def part(evs):
            body = json.dumps({"EventStatus": evs}).encode()
            chunk = b"--SamsungTechwin\r\nContent-Type: application/json\r\n\r\n" + body + b"\r\n"
            self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
            self.wfile.flush()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=SamsungTechwin")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            last = {json.dumps(e["Source"]) + e["EventName"]: e["Data"] for e in all_states()}
            part(all_states())
            t_hb = time.time()
            for _ in range(1200):
                time.sleep(0.05)
                diff = []
                for e in all_states():
                    k = json.dumps(e["Source"]) + e["EventName"]
                    if last.get(k) != e["Data"]:
                        last[k] = e["Data"]
                        diff.append(e)
                if diff:
                    part(diff)
                elif time.time() - t_hb > 5:
                    part([]); t_hb = time.time()
        except Exception:
            pass
        finally:
            monitors.release()
            self.close_connection = True


class Redirect(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", f"https://127.0.0.1:{HTTPS_PORT}{self.path}")
        self.send_header("Content-Length", "0")
        self.end_headers()


if __name__ == "__main__":
    HTTPS_PORT, HTTP_PORT = int(sys.argv[1]), int(sys.argv[2])
    srv = ThreadingHTTPServer((os.environ.get("MOCK_BIND", "127.0.0.1"), HTTPS_PORT), H)
    srv.daemon_threads = True
    if len(sys.argv) >= 5:   # no cert given -> plain HTTP on the first port
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(sys.argv[3], sys.argv[4])
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    r = ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), Redirect)
    threading.Thread(target=r.serve_forever, daemon=True).start()
    print("mock up", flush=True)
    srv.serve_forever()
