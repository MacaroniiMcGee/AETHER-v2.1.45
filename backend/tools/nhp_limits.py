#!/usr/bin/env python3
"""
nhp_limits.py - probe a Hanwha NHP access controller over SUNAPI and write
everything it finds (declared limits, measured limits, failures) into an
Excel report.

Python 3.8+, standard library only. If `openpyxl` is installed the report is
an .xlsx workbook; otherwise one CSV per sheet is written.

  pip install openpyxl            (optional, for the .xlsx report)

Quick start (read-only tests, nothing on the controller changes):

  python nhp_limits.py --host 192.168.1.101 --user admin

Test levels (--levels, comma separated):
  discovery   read-only  device info, attributes.cgi spec, capabilities, doors,
                         every 'view' command
  protocol    read-only  HTTP/HTTPS, TLS, auth schemes, nonce reuse, keep-alive,
                         URL length
  validation  read-only  bad tokens / commands / params -> error codes,
                         controller still healthy afterwards
  load        read-only  latency, concurrent connections, event-monitor streams
  door        HARDWARE   releases a real door (needs --door-token)
  capacity    WRITES     adds test objects (prefix ZZT) until the controller
                         refuses, then removes them
  lockout     LOCKS LOGIN sends wrong passwords until the controller locks out

Default: discovery,protocol,validation,load.  'all' = every level.
"""
from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import getpass
import hashlib
import http.client
import json
import os
import re
import socket
import ssl
import statistics
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import warnings
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

warnings.filterwarnings("ignore", category=DeprecationWarning)

VERSION = "1.5.0"
SAFE_LEVELS = ["discovery", "protocol", "validation", "load", "connector"]
ALL_LEVELS = SAFE_LEVELS + ["door", "capacity", "lockout"]
RESULTS = ["PASS", "FAIL", "LIMIT", "INFO", "SKIP", "ERROR"]


# --------------------------------------------------------------------------
# HTTP + Digest client
# --------------------------------------------------------------------------

def _unverified_ctx(min_v=None, max_v=None) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    if min_v or max_v:
        try:
            ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
        except ssl.SSLError:
            pass
        if min_v:
            ctx.minimum_version = min_v
        if max_v:
            ctx.maximum_version = max_v
    return ctx


@dataclass
class Resp:
    status: int = 0
    reason: str = ""
    headers: List[Tuple[str, str]] = field(default_factory=list)
    body: bytes = b""
    ms: float = 0.0
    error: Optional[str] = None
    method: str = "GET"
    url: str = ""

    def header(self, name: str) -> Optional[str]:
        for k, v in self.headers:
            if k.lower() == name.lower():
                return v
        return None

    def header_all(self, name: str) -> List[str]:
        return [v for k, v in self.headers if k.lower() == name.lower()]

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    def short(self, n: int = 300) -> str:
        if self.error:
            return f"[{self.error}]"
        t = self.text.strip().replace("\r", "")
        return (f"HTTP {self.status} " + (t[:n] + ("..." if len(t) > n else ""))).strip()


@dataclass
class Result:
    ok: bool = False
    code: Optional[str] = None
    details: str = ""
    reason: str = ""
    data: Any = None

    def label(self) -> str:
        if self.ok:
            return "OK"
        bits = [b for b in [self.code and f"code {self.code}", self.details, self.reason] if b]
        return "NG " + " / ".join(bits) if bits else "NG"


def parse_sunapi(resp: Resp) -> Result:
    r = Result()
    if resp.error:
        r.reason = resp.error
        r.code = "NETWORK"
        return r
    txt = resp.text.strip()
    j = None
    if txt[:1] in "{[":
        try:
            j = json.loads(txt)
        except ValueError:
            j = None
    if resp.status != 200:
        r.code = f"HTTP {resp.status}"
        if isinstance(j, dict) and isinstance(j.get("Error"), dict):
            r.code = str(j["Error"].get("Code", r.code))
            r.details = str(j["Error"].get("Details", ""))
            r.reason = str(j["Error"].get("Reason", ""))
        else:
            r.reason = txt[:200]
        return r
    if isinstance(j, dict):
        r.data = j
        if str(j.get("Response", "")).lower() == "fail" or "Error" in j:
            e = j.get("Error") if isinstance(j.get("Error"), dict) else {}
            r.code = str(e.get("Code", "")) or None
            r.details = str(e.get("Details", ""))
            r.reason = str(e.get("Reason", ""))
            return r
        r.ok = True
        return r
    if j is not None:
        r.data = j
        r.ok = True
        return r
    if txt.upper().startswith("NG"):
        m = re.search(r"Error\s*Code\s*:\s*(\S+)", txt, re.I)
        r.code = m.group(1) if m else None
        m = re.search(r"Error\s*Details\s*:\s*(.*)", txt, re.I | re.S)
        r.details = m.group(1).strip()[:200] if m else ""
        return r
    r.ok = True
    r.data = txt
    return r


def parse_challenges(values: List[str]) -> List[Dict[str, str]]:
    out = []
    for v in values:
        scheme, _, rest = v.strip().partition(" ")
        d = {"scheme": scheme.lower()}
        for m in re.finditer(r'([\w-]+)\s*=\s*("([^"]*)"|[^,\s]+)', rest):
            d[m.group(1).lower()] = m.group(3) if m.group(3) is not None else m.group(2)
        out.append(d)
    return out


class Client:
    def __init__(self, host, port, scheme, user, password, root="stw-cgi",
                 timeout=10.0, json_accept=True, log=None, max_body=8 * 1024 * 1024,
                 prefer_alg=None):
        self.host, self.port, self.scheme = host, port, scheme
        self.user, self.password = user, password
        self.root = root.strip("/")
        self.timeout = timeout
        self.json_accept = json_accept
        self.max_body = max_body
        self.prefer_alg = prefer_alg
        self.log = log
        self._lock = threading.Lock()
        self._chal: Optional[Dict[str, str]] = None
        self._nc = 0
        self.count = 0

    # ---- low level -------------------------------------------------------
    def _conn(self, scheme=None, port=None, timeout=None, ctx=None):
        scheme = scheme or self.scheme
        port = port or self.port
        t = timeout or self.timeout
        if scheme == "https":
            return http.client.HTTPSConnection(self.host, port, timeout=t, context=ctx or _unverified_ctx())
        return http.client.HTTPConnection(self.host, port, timeout=t)

    def raw(self, method, path, body=None, headers=None, scheme=None, port=None,
            timeout=None, conn=None, read_cap=None) -> Resp:
        h = {"User-Agent": f"nhp-limits/{VERSION}"}
        if self.json_accept:
            h["Accept"] = "application/json"
        h.update(headers or {})
        url = f"{scheme or self.scheme}://{self.host}:{port or self.port}{path}"
        r = Resp(method=method, url=url)
        own = conn is None
        c = conn or self._conn(scheme, port, timeout)
        t0 = time.perf_counter()
        try:
            c.request(method, path, body=body, headers=h)
            hr = c.getresponse()
            r.status, r.reason = hr.status, hr.reason
            r.headers = list(hr.getheaders())
            r.body = hr.read(read_cap or self.max_body)
        except Exception as e:  # network-level failure is a result, not a crash
            r.error = f"{type(e).__name__}: {e}"
        finally:
            r.ms = (time.perf_counter() - t0) * 1000
            if own:
                try:
                    c.close()
                except Exception:
                    pass
        with self._lock:
            self.count += 1
        if self.log:
            self.log(r, h)
        return r

    # ---- digest ----------------------------------------------------------
    def _pick(self, chals: List[Dict[str, str]], alg=None) -> Optional[Dict[str, str]]:
        dig = [c for c in chals if c["scheme"] == "digest"]
        if not dig:
            return None
        want = (alg or self.prefer_alg or "").upper()
        if want:
            for c in dig:
                if c.get("algorithm", "MD5").upper() == want:
                    return c
            return None if alg else dig[0]
        for pref in ("SHA-256", "MD5"):
            for c in dig:
                if c.get("algorithm", "MD5").upper() == pref:
                    return c
        return dig[0]

    def digest_header(self, method, uri, chal, user=None, password=None, nc=None) -> str:
        user = self.user if user is None else user
        password = self.password if password is None else password
        alg = chal.get("algorithm", "MD5")
        base = alg.upper().replace("-SESS", "")
        hname = {"MD5": "md5", "SHA-256": "sha256", "SHA-512-256": "sha512_256", "SHA-512": "sha512"}.get(base, "md5")

        def H(s):
            return hashlib.new(hname, s.encode("utf-8")).hexdigest()

        realm, nonce = chal.get("realm", ""), chal.get("nonce", "")
        cnonce = os.urandom(8).hex()
        ha1 = H(f"{user}:{realm}:{password}")
        if alg.upper().endswith("-SESS"):
            ha1 = H(f"{ha1}:{nonce}:{cnonce}")
        ha2 = H(f"{method}:{uri}")
        qops = [q.strip() for q in chal.get("qop", "").split(",") if q.strip()]
        if nc is None:
            with self._lock:
                self._nc += 1
                nc = self._nc
        if "auth" in qops:
            resp = H(f"{ha1}:{nonce}:{nc:08x}:{cnonce}:auth:{ha2}")
            q = f', qop=auth, nc={nc:08x}, cnonce="{cnonce}"'
        else:
            resp = H(f"{ha1}:{nonce}:{ha2}")
            q = ""
        hdr = (f'Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{uri}", '
               f'algorithm={alg}, response="{resp}"{q}')
        if "opaque" in chal:
            hdr += f', opaque="{chal["opaque"]}"'
        return hdr

    def request(self, method, path, body=None, headers=None, auth="digest",
                alg=None, user=None, password=None, timeout=None, read_cap=None) -> Resp:
        headers = dict(headers or {})
        if auth == "none":
            return self.raw(method, path, body, headers, timeout=timeout, read_cap=read_cap)
        if auth == "basic":
            tok = base64.b64encode(f"{user or self.user}:{password if password is not None else self.password}".encode()).decode()
            headers["Authorization"] = "Basic " + tok
            return self.raw(method, path, body, headers, timeout=timeout, read_cap=read_cap)
        chal = None if (alg or user or password is not None) else self._chal
        if chal:
            headers["Authorization"] = self.digest_header(method, path, chal, user, password)
            r = self.raw(method, path, body, headers, timeout=timeout, read_cap=read_cap)
            if r.status != 401:
                return r
        else:
            r = self.raw(method, path, body, headers, timeout=timeout, read_cap=read_cap)
            if r.status != 401:
                return r
        new = self._pick(parse_challenges(r.header_all("WWW-Authenticate")), alg)
        if not new:
            return r
        if not (alg or user or password is not None):
            with self._lock:
                self._chal, self._nc = new, 0
        headers["Authorization"] = self.digest_header(method, path, new, user, password,
                                                      nc=1 if (alg or user or password is not None) else None)
        return self.raw(method, path, body, headers, timeout=timeout, read_cap=read_cap)

    # ---- SUNAPI ----------------------------------------------------------
    def path(self, cgi, submenu=None, action=None, params=None) -> str:
        q = []
        if submenu:
            q.append(("msubmenu", submenu))
        if action:
            q.append(("action", action))
        if params:
            q.extend(params.items() if isinstance(params, dict) else params)
        qs = "&".join(f"{k}={urllib.parse.quote(str(v), safe='.,:-_*')}" for k, v in q)
        return f"/{self.root}/{cgi}.cgi" + (f"?{qs}" if qs else "")

    def sunapi(self, cgi, submenu, action, params=None, method="GET", body=None,
               headers=None, timeout=None) -> Tuple[Resp, Result]:
        r = self.request(method, self.path(cgi, submenu, action, params), body=body,
                         headers=headers, timeout=timeout)
        return r, parse_sunapi(r)


# --------------------------------------------------------------------------
# attributes.cgi parser
# --------------------------------------------------------------------------

@dataclass
class Param:
    cgi: str
    submenu: str
    action: str
    name: str
    req: bool = False
    res: bool = False
    type: str = ""
    values: List[str] = field(default_factory=list)
    min: Optional[float] = None
    max: Optional[float] = None
    minlen: Optional[int] = None
    maxlen: Optional[int] = None
    extra: str = ""

    def spec(self) -> str:
        if self.values:
            return ",".join(self.values)
        parts = []
        if self.min is not None or self.max is not None:
            parts.append(f"{_num(self.min)}..{_num(self.max)}")
        if self.minlen is not None or self.maxlen is not None:
            parts.append(f"len {_num(self.minlen) if self.minlen is not None else 0}..{_num(self.maxlen)}")
        if self.extra:
            parts.append(self.extra)
        return " ".join(parts)


def _num(v):
    if v is None:
        return ""
    return str(int(v)) if float(v).is_integer() else str(v)


def _to_num(s):
    try:
        f = float(s)
        return f
    except (TypeError, ValueError):
        return None


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _truthy(v) -> bool:
    return str(v).strip().lower() in ("true", "1", "yes")


def repair_xml(text: str) -> str:
    # Angle brackets inside attribute values (e.g. name="<AppID>.X") are not legal XML.
    return re.sub(r'"([^"]*)"', lambda m: '"' + m.group(1).replace("<", "&lt;").replace(">", "&gt;") + '"', text)


class Catalog:
    def __init__(self):
        self.cgis: Dict[str, Dict[str, Dict[str, List[Param]]]] = {}
        self.attributes: Dict[str, str] = {}

    def parse(self, text: str):
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            root = ET.fromstring(repair_xml(text))
        self._walk(root, [], None, None, None)
        return self

    def _walk(self, el, path, cgi, sub, act):
        tag = _local(el.tag)
        name = el.attrib.get("name") or el.attrib.get("Name") or ""
        if tag == "cgi":
            cgi, sub, act = name, None, None
            self.cgis.setdefault(cgi, {})
        elif tag == "submenu" and cgi:
            sub, act = name, None
            self.cgis[cgi].setdefault(sub, {})
        elif tag == "action" and cgi and sub:
            act = name
            self.cgis[cgi][sub].setdefault(act, [])
        elif tag == "parameter" and cgi and sub and act:
            self.cgis[cgi][sub][act].append(self._param(el, cgi, sub, act, name))
            return
        elif tag == "attribute":
            key = "/".join(path + [name])
            val = el.attrib.get("value")
            if val is None:
                val = (el.text or "").strip()
            self.attributes[key] = val
            return
        if tag in ("group", "category") and name:
            path = path + [name]
        for ch in el:
            self._walk(ch, path, cgi, sub, act)

    def _param(self, el, cgi, sub, act, name) -> Param:
        p = Param(cgi, sub, act, name, _truthy(el.attrib.get("request", "")),
                  _truthy(el.attrib.get("response", "")))
        dt_el = None
        for ch in el:
            if _local(ch.tag) == "datatype":
                dt_el = ch
                break
        holder = list(dt_el) if dt_el is not None else []
        if not holder:
            holder = [ch for ch in el if _local(ch.tag) in ("enum", "int", "integer", "float", "bool", "boolean", "string", "csv", "datetime", "time")]
        if holder:
            t = holder[0]
            p.type = _local(t.tag)
            a = {k.lower(): v for k, v in t.attrib.items()}
            p.min, p.max = _to_num(a.get("min")), _to_num(a.get("max"))
            ml = _to_num(a.get("maxlen") or a.get("maxlength"))
            p.maxlen = int(ml) if ml is not None else None
            mn = _to_num(a.get("minlen") or a.get("minlength"))
            p.minlen = int(mn) if mn is not None else None
            for e in t.iter():
                if _local(e.tag) == "entry":
                    v = e.attrib.get("value") or e.attrib.get("name") or (e.text or "").strip()
                    if v:
                        p.values.append(v)
            rest = {k: v for k, v in a.items() if k not in ("min", "max", "maxlen", "maxlength", "minlen", "minlength")}
            if rest:
                p.extra = " ".join(f"{k}={v}" for k, v in rest.items())
            if p.type == "boolean":
                p.type = "bool"
            if p.type == "integer":
                p.type = "int"
        return p

    def has(self, cgi, sub=None, act=None) -> bool:
        c = self.cgis.get(cgi)
        if c is None:
            return False
        if sub is None:
            return True
        s = c.get(sub)
        if s is None:
            return False
        return act is None or act in s

    def params(self, cgi, sub, act) -> List[Param]:
        return self.cgis.get(cgi, {}).get(sub, {}).get(act, [])

    def actions(self):
        for cgi, subs in self.cgis.items():
            for sub, acts in subs.items():
                for act, ps in acts.items():
                    yield cgi, sub, act, ps

    def counts(self):
        c = len(self.cgis)
        s = sum(len(v) for v in self.cgis.values())
        a = sum(1 for _ in self.actions())
        p = sum(len(ps) for *_, ps in self.actions())
        return c, s, a, p


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------

PROGRESS = os.environ.get("NHP_PROGRESS") == "1"


def progress(obj):
    """Machine-readable progress for Aether: one '@@{json}' line per event."""
    if PROGRESS:
        print("@@" + json.dumps(obj, ensure_ascii=False), flush=True)


class Report:
    RESULT_COLS = ["ID", "Level", "Test", "What it checks", "Expected / declared",
                   "Measured", "Result", "Notes", "Request", "Response", "ms"]

    def __init__(self):
        self.rows: List[List[Any]] = []
        self.limits: List[List[Any]] = []
        self.features: List[List[Any]] = []
        self.spec: List[List[Any]] = []
        self.views: List[List[Any]] = []
        self.doors: List[List[Any]] = []
        self.timeline: List[List[Any]] = []
        self.capacity: List[List[Any]] = []
        self.push: List[List[Any]] = []
        self.responses: List[List[Any]] = []
        self.events: List[List[Any]] = []
        self.errors: Dict[str, Dict[str, Any]] = {}
        self.info: List[List[Any]] = []
        self._lock = threading.Lock()

    def add(self, tid, level, test, checks, expected, measured, result, notes="",
            request="", response="", ms=None):
        assert result in RESULTS, result
        row = [tid, level, test, checks, _cell(expected), _cell(measured), result, notes,
               request, _cell(response)[:2000], round(ms, 1) if isinstance(ms, (int, float)) else ""]
        with self._lock:
            self.rows.append(row)
        print(f"  [{result:5}] {tid} {test}: {_cell(measured)[:110]}")
        progress({"t": "result", "id": tid, "level": level, "test": test, "result": result, "measured": _cell(measured)[:300]})

    def full(self, tid, level, test, r: "Resp"):
        """Keep the whole controller response so a firmware comparison can diff every field."""
        with self._lock:
            self.responses.append([tid, level, test, r.url, r.status or r.error, r.text[:30000]])

    def push_check(self, tid, level, test, before, pushed, reply_ok, reply, after, expected, match, notes=""):
        """inspect -> push -> reinspect. match: True / False / None (no readback possible)."""
        if reply_ok and match is True:
            verdict = "APPLIED"
        elif reply_ok and match is False:
            verdict = "NOT APPLIED"      # controller said OK but the readback disagrees
        elif reply_ok:
            verdict = "UNVERIFIED"       # said OK, nothing to read back
        elif match is True:
            verdict = "REFUSED"          # said NG and nothing changed (clean refusal)
        elif match is False:
            verdict = "PARTIAL"          # said NG but something changed anyway
        else:
            verdict = "REFUSED?"
        with self._lock:
            self.push.append([tid, level, test, _cell(before)[:500], _cell(pushed)[:500], _cell(reply)[:300],
                              _cell(after)[:500], _cell(expected)[:300],
                              {True: "yes", False: "NO", None: "n/a"}[match], verdict, notes])
        return verdict

    def limit(self, name, value, source, notes=""):
        with self._lock:
            self.limits.append([name, _cell(value), source, notes])

    def err(self, res: Result, where: str):
        if res.ok or not res.code:
            return
        with self._lock:
            e = self.errors.setdefault(res.code, {"details": set(), "reasons": set(), "where": []})
            if res.details:
                e["details"].add(res.details)
            if res.reason:
                e["reasons"].add(res.reason[:120])
            if len(e["where"]) < 12:
                e["where"].append(where)

    def counts(self):
        out = {k: 0 for k in RESULTS}
        for r in self.rows:
            out[r[6]] += 1
        return out


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)[:2000]
    return str(v)


# --------------------------------------------------------------------------
# Plain-language explanations for the Limits / Features sheets
# --------------------------------------------------------------------------

OBJ_NAMES = {
    "Door": "doors", "CredentialReader": "card readers", "Schedule": "schedules",
    "AccessPoint": "access points (door + reader direction)", "AccessProfile": "access profiles (access levels)",
    "AccessGroup": "access groups", "CredentialMethod": "credential methods (individual card numbers / PINs)",
    "Credential": "credentials (one per cardholder, holding cards / PINs)",
    "AuthenticationProfile": "authentication profiles", "SecurityLevel": "security levels",
}
CAP_FIELDS = {
    "MaxAreas": "Most areas (zones that access points belong to).",
    "MaxTimePeriodsPerDay": "Most time periods one schedule can have in a single day (e.g. 08:00-12:00 and 13:00-17:00 = 2).",
    "MaxSpecialDayGroups": "Most special-day (holiday) groups the controller can store.",
    "MaxDaysInSpecialDayGroup": "Most days one special-day (holiday) group can contain.",
    "MaxSpecialDaysPerSchedules": "Most special-day groups one schedule can reference.",
    "MaxAuthenticationProfiles": "Most authentication profiles (rules for which credential types a door needs).",
    "MaxPoliciesPerAuthenticationProfile": "Most policies inside one authentication profile.",
    "MaxSecurityLevels": "Most security levels (e.g. card only / card + PIN).",
    "MaxRecognitionGroupsPerSecurityLevel": "Most recognition groups inside one security level.",
    "MaxRecognitionMethodsPerRecognitionGroup": "Most recognition methods (card, PIN...) in one recognition group.",
    "MaxAccessPoliciesPerAccessProfile": "Most access policies (door + schedule pairs) in one access profile / access level.",
    "MaxSchedulesPerAccessPolicy": "Most schedules one access policy can use.",
    "MaxSchedulePerAccessProfiles": "Most schedules referenced per access profile within a group.",
    "MaxAccessProfilesPerCredential": "Most access profiles (access levels) one credential / cardholder can have.",
    "MaxCredentialMethodsPerCredential": "Most card numbers / PINs one credential can hold.",
    "MaxGroupsPerCredential": "Most access groups one credential can belong to.",
}
DOOR_TIMINGS = {
    "ReleaseTime": ("How long the lock stays released after a granted card or an Access command.", "seconds"),
    "MaxOpenTime": ("How long the door may stay open after a release before a 'door held open' alarm.", "seconds"),
    "ExtendedReleaseTime": ("Release time for cardholders flagged for extended access (e.g. ADA).", "seconds"),
    "DelayTimeBeforeRelock": ("Wait after the door closes before the lock re-engages.", "seconds"),
    "ExtendedOpenTime": ("Held-open time allowed for cardholders flagged for extended access.", "seconds"),
}
MEASURED = [
    (r"^Digest nonce reuse count", "How many requests one login challenge (nonce) covers before the controller asks for a new one. Low = every request needs an extra round trip.", "requests"),
    (r"^Max URL length", "Longest request URL the controller's web server accepts. Matters for long CSV lists or bulk parameters in one call.", "characters"),
    (r"p95 latency", "Response time for 95% of requests, one request at a time (includes TLS + login).", "milliseconds"),
    (r"sequential rate", "Requests per second one client can do back-to-back.", "requests per second"),
    (r"^Concurrent clients", "Most clients that can call the controller at the same time with every request succeeding.", "parallel clients"),
    (r"^Simultaneous event monitor streams", "Most event streams (monitordiff) that can be open at once. The Cloud Connector uses one, each VMS / integration another.", "streams"),
    (r"^Stream slot release", "How long the controller keeps a stream slot busy after the client disconnects. During this time new listeners are refused.", "seconds"),
    (r"^eventstatus check size", "Size of the full state snapshot (eventstatus check SchemaBased) the Cloud Connector reads.", "bytes"),
    (r"^monitordiff first part", "Time from opening the event stream to the first state snapshot arriving.", "seconds"),
    (r"^monitordiff initial state entries", "Number of states (doors, locks, readers...) in the first snapshot of the event stream.", "entries"),
    (r"^Observed release duration", "How long the door actually stayed released after one Access command, polled from the controller.", "seconds"),
    (r"^Door command -> event latency", "Time from sending a door command to its event arriving on the stream the Cloud Connector reads. Adds to cloud event delay.", "seconds"),
    (r"^Release duration by events", "Unlock-to-relock time measured from the event stream (more precise than polling).", "seconds"),
    (r" max objects$", "Most objects of this type the controller actually stored before refusing (measured by adding test objects).", "objects"),
    (r" Name max length$", "Longest Name the controller stored unchanged (pushed, then read back).", "characters"),
    (r"^Login lockout threshold", "Wrong passwords in a row before the controller locks that login.", "attempts"),
    (r"^Login lockout duration", "How long a locked login stays locked before it works again.", "seconds"),
    (r"^Doors configured", "Doors defined on the controller right now (door/view).", "doors"),
]


def _words(name: str) -> str:
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name).lower()


def explain_limit(name: str, value, source: str, notes: str = "") -> Tuple[str, str]:
    """-> (what the limit means, how to read the value)"""
    v = str(value)
    desc, unit = "", ""
    m = re.match(r"^(?:Capabilities\.)?(\w+)\.(Max\w*)$", name)
    m_door = re.match(r"^Door (\S+) Timings\.(\w+)$", name)
    m_spec = re.match(r"^(\w+)/(\w+(?:/\w+)?) (.+)$", name) if source == "attributes.cgi" and " " in name else None
    if m_door and m_door.group(2) in DOOR_TIMINGS:
        d, unit = DOOR_TIMINGS[m_door.group(2)]
        desc = f"Door {m_door.group(1)}: {d}"
    elif m and source == "capabilities":
        obj, field_ = m.group(1), m.group(2)
        if field_ == "MaxCount":
            desc = f"Most {OBJ_NAMES.get(obj, _words(obj))} the controller can hold (declared by the firmware)."
        else:
            desc = CAP_FIELDS.get(field_, f"{obj}: {_words(field_)} (declared by the firmware).")
        unit = "count"
    elif m_spec:
        desc = (f"Allowed values for the '{m_spec.group(3)}' field when calling {m_spec.group(1)}/{m_spec.group(2)}, "
                "as published in the API spec.")
        unit = "'len a..b' = text length in characters; 'a..b' = number range; a list = the only accepted values"
    elif source == "attributes.cgi":
        leaf = name.rsplit("/", 1)[-1]
        desc = f"Device attribute '{_words(leaf.replace('Max', 'max '))}' from the published spec ({name.rsplit('/', 1)[0]})."
        unit = "count" if re.search(r"max|count|num", leaf, re.I) else ""
    else:
        for rx, d, u in MEASURED:
            if re.search(rx, name):
                desc, unit = d, u
                break
    if not desc:
        desc = _words(name).capitalize()
    if v.startswith(">="):
        vm = f"At least {v[2:]} {unit} - the test stopped at its own cap before the controller refused, so the real limit is higher."
    elif v.startswith(">"):
        vm = f"More than {v[1:]} {unit} - not reached within the test range."
    elif unit and _to_num(v) is not None:
        vm = f"{v} {unit}"
        if unit == "seconds" and float(v) == 0:
            vm += " (0 = feature off / not used)"
    else:
        vm = unit or "as reported"
    return desc, vm.strip()


# SUNAPI (ONVIF access-control model) -> what OnCAFE calls it. confidence: confirmed / field / likely
ONCAFE_MAP = [
    # (capability path suffix or measured-limit regex, OnCAFE term, what it limits, confidence, note)
    ("AccessProfile.MaxCount", "Access Levels", "Access levels stored on the controller", "confirmed", "SUNAPI AccessProfile = OnCAFE Access Level"),
    ("Credential.MaxAccessProfilesPerCredential", "Access Levels per identity", "Access levels one identity can hold (direct + through groups)", "field",
     "Matches the OnCAFE field finding: an identity cannot hold more than 10 access levels"),
    ("AccessProfile.MaxAccessPoliciesPerAccessProfile", "Doors per Access Level", "Door + schedule pairs inside one access level", "likely", ""),
    ("AccessProfile.MaxSchedulesPerAccessPolicy", "Schedules per door in an Access Level", "Schedules one door can use inside an access level", "likely", ""),
    ("AccessGroup.MaxCount", "Cardholder Groups", "Groups stored on the controller", "likely", "SUNAPI AccessGroup"),
    ("Credential.MaxGroupsPerCredential", "Groups per identity", "Cardholder groups one identity can be in", "likely", ""),
    ("Credential.MaxCount", "Identities / credentials", "Credentials stored on the controller (one per cardholder)", "likely", ""),
    ("CredentialMethod.MaxCount", "Cards and PINs", "Card numbers / PINs stored on the controller", "likely", "SUNAPI CredentialMethod"),
    ("Credential.MaxCredentialMethodsPerCredential", "Cards / PINs per identity", "Card numbers / PINs one identity can have", "likely", ""),
    ("Schedule.MaxCount", "Schedules", "Schedules stored on the controller", "likely", ""),
    ("Schedule.MaxTimePeriodsPerDay", "Time slots per day", "Time periods in one schedule day", "likely", ""),
    ("Schedule.MaxSpecialDayGroups", "Holiday groups", "Holiday (special-day) groups", "likely", "SUNAPI SpecialDayGroup"),
    ("Schedule.MaxDaysInSpecialDayGroup", "Days per holiday group", "Dates in one holiday group", "likely", ""),
    ("Door.MaxCount", "Doors", "Doors on this controller", "likely", ""),
    ("CredentialReader.MaxCount", "Readers", "Card readers on this controller", "likely", ""),
    ("AccessPoint.MaxCount", "Door entry / exit points", "Access points (a door with a reader direction)", "likely", "SUNAPI AccessPoint"),
    ("AccessPoint.MaxAreas", "Areas", "Areas access points belong to", "likely", ""),
    ("SecurityLevel.MaxSecurityLevels", "Reader security modes", "Card only / card + PIN style levels", "likely", "SUNAPI SecurityLevel"),
    ("AuthenticationProfile.MaxAuthenticationProfiles", "Authentication profiles", "Rules for which credential types a door needs", "likely", ""),
    (r"^accessprofile max objects$", "Access Levels (measured)", "Access levels actually stored before the controller refused", "confirmed", ""),
    (r"^accessschedule max objects$", "Schedules (measured)", "Schedules actually stored before the controller refused", "likely", ""),
    (r"^specialdaygroup max objects$", "Holiday groups (measured)", "Holiday groups actually stored before the controller refused", "likely", ""),
    (r"^accessgroup max objects$", "Cardholder Groups (measured)", "Groups actually stored before the controller refused", "likely", ""),
    (r"^accessprofile Name max length$", "Access Level name length", "Longest access-level name stored unchanged", "confirmed", ""),
    (r"^accessschedule Name max length$", "Schedule name length", "Longest schedule name stored unchanged", "likely", ""),
    (r"^accessgroup Name max length$", "Group name length", "Longest group name stored unchanged", "likely", ""),
    (r"^Simultaneous event monitor streams$", "Event listeners", "Event streams at once; the Cloud Connector uses one", "likely", ""),
    (r"^Door command -> event latency", "Door event delay (controller part)", "Command to event on the stream the Cloud Connector reads", "likely", "Cloud delay adds to this"),
    (r"^Doors configured$", "Doors set up", "Doors defined on the controller now", "likely", ""),
]


def oncafe_rows(limits) -> List[List[Any]]:
    """Limits sheet rows -> OnCAFE view rows."""
    out = []
    for key, term, what, conf, note in ONCAFE_MAP:
        hits = [r for r in limits if (r[0].endswith(key) if not key.startswith("^") else re.search(key, r[0]))]
        for name, value, src, nt in hits[:1]:
            out.append([term, what, value, "declared" if src in ("capabilities", "attributes.cgi") else src, name,
                        {"confirmed": "Confirmed", "field": "Matches field finding", "likely": "Likely"}[conf], note])
    return out


SOURCE_MEANING = {
    "capabilities": "DECLARED - the controller's own 'accesscontrol capabilities' answer: what the firmware says it supports. "
                    "The Cloud Connector reads the same call.",
    "attributes.cgi": "DECLARED - the controller's published API spec (attributes.cgi), the same tree the SUNAPI test client shows.",
    "door/view": "CONFIGURED - the door's current settings on this controller (installer / cloud can change them).",
    "measured": "MEASURED - observed by this test run on this controller. This is what the device actually does.",
    "connector": "READ with the same SUNAPI call the Cloud Connector makes.",
}


def source_meaning(src: str) -> str:
    return SOURCE_MEANING.get(src, src)


def write_report(rep: Report, out: str, meta: Dict[str, str]) -> str:
    counts = rep.counts()
    findings = [r for r in rep.rows if r[6] in ("LIMIT", "FAIL", "ERROR")]
    summary = [["Field", "Value"]] + [[k, v] for k, v in meta.items()]
    summary += [["", ""], ["Results", ""]] + [[k, counts[k]] for k in RESULTS]
    pv = {}
    for r in rep.push:
        pv[r[9]] = pv.get(r[9], 0) + 1
    if pv:
        summary += [["", ""], ["Push checks (inspect > push > reinspect)", ""]] + [[k, v] for k, v in sorted(pv.items())]
    summary += [["", ""], ["Key findings (LIMIT / FAIL / ERROR)", ""]]
    summary += [[f"{r[0]} {r[2]}", f"{r[6]}: {r[5]}"] for r in findings]
    errs = [["Error code", "Details seen", "Reasons seen", "Where (first 12)"]]
    for code, e in sorted(rep.errors.items(), key=lambda kv: str(kv[0])):
        errs.append([code, " | ".join(sorted(e["details"])), " | ".join(sorted(e["reasons"])), "\n".join(e["where"])])
    sheets = [
        ("Summary", summary),
        ("Results", [Report.RESULT_COLS] + rep.rows),
        ("OnCAFE map", [["OnCAFE term", "What it limits", "Value", "Source", "SUNAPI name", "Mapping", "Notes"]]
         + oncafe_rows(rep.limits)),
        ("Limits", [["Limit / property", "What it means", "Value", "How to read the value", "Source",
                     "What the source means", "Notes"]]
         + [[n, *explain_limit(n, v, src, nt)[:1], v, explain_limit(n, v, src, nt)[1], src, source_meaning(src), nt]
            for n, v, src, nt in rep.limits]),
        ("Features", [["Feature / capability", "Value", "Source", "What the source means", "Notes"]]
         + [[n, v, src, source_meaning(src), nt] for n, v, src, nt in rep.features]),
        ("Doors", [["Token", "Name", "Enabled", "Mode", "Lock wired", "Reader in", "Reader out", "DPS", "REX in",
                    "Release s", "Max open s", "Ext release s", "Supported commands", "Not supported"]] + rep.doors),
        ("View sweep", [["CGI", "Submenu", "Action", "Params sent", "Result", "Error", "HTTP", "Bytes", "ms"]] + rep.views),
        ("API spec", [["CGI", "Submenu", "Action", "Parameter", "Req", "Res", "Type", "Allowed values / range"]] + rep.spec),
        ("Error codes", errs),
        ("Push checks", [["ID", "Level", "Test", "Before (inspect)", "Pushed", "Push reply", "After (reinspect)",
                          "Expected after", "Match", "Verdict", "Notes"]] + rep.push),
        ("Capacity", [["Submenu", "Test", "Value tried", "Accepted", "Error", "ms", "Notes"]] + rep.capacity),
        ("Events", [["Test", "t (s)", "EventName", "Source", "Data", "Controller time"]] + rep.events),
        ("Responses", [["ID", "Level", "Test", "URL", "HTTP", "Body"]] + rep.responses),
        ("Door timeline", [["Test", "t (s)", "Event", "Detail"]] + rep.timeline),
    ]
    if JSON_OUT:
        with open(JSON_OUT, "w", encoding="utf-8") as f:
            json.dump({"name": os.path.basename(out), "sheets": {n: [[_jsonable(v) for v in r] for r in rows] for n, rows in sheets}},
                      f, ensure_ascii=False)
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
    except ImportError:
        write_xlsx_stdlib(out, sheets)
        return out

    fills = {"PASS": "C6EFCE", "FAIL": "FFC7CE", "LIMIT": "FFEB9C", "INFO": "DDEBF7",
             "SKIP": "EDEDED", "ERROR": "F4B183"}
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets:
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append([_xl(v) for v in r])
        hdr = Font(bold=True, color="FFFFFF")
        for c in ws[1]:
            c.font = hdr
            c.fill = PatternFill("solid", fgColor="305496")
        ws.freeze_panes = "A2"
        if ws.max_row > 1:
            ws.auto_filter.ref = ws.dimensions
        for i, col in enumerate(ws.iter_cols(min_row=1, max_row=min(ws.max_row, 400)), start=1):
            w = max((len(str(c.value)) if c.value is not None else 0) for c in col)
            ws.column_dimensions[get_column_letter(i)].width = max(8, min(60, w + 2))
        for row in ws.iter_rows(min_row=2):
            for c in row:
                c.alignment = Alignment(vertical="top", wrap_text=isinstance(c.value, str) and len(c.value) > 60)
        if name == "Results":
            for row in ws.iter_rows(min_row=2):
                res = row[6].value
                if res in fills:
                    row[6].fill = PatternFill("solid", fgColor=fills[res])
                    row[6].font = Font(bold=True)
        if name == "Push checks":
            vf = {"APPLIED": "C6EFCE", "REFUSED": "DDEBF7", "NOT APPLIED": "FFC7CE", "PARTIAL": "FFC7CE",
                  "UNVERIFIED": "FFEB9C", "REFUSED?": "FFEB9C"}
            for row in ws.iter_rows(min_row=2):
                v = row[9].value
                if v in vf:
                    row[9].fill = PatternFill("solid", fgColor=vf[v])
                    row[9].font = Font(bold=True)
        if name == "Summary":
            for row in ws.iter_rows(min_row=2):
                if row[0].value in fills:
                    row[0].fill = PatternFill("solid", fgColor=fills[row[0].value])
                if row[0].value in ("Results", "Key findings (LIMIT / FAIL / ERROR)"):
                    row[0].font = Font(bold=True)
    wb.save(out)
    return out


JSON_OUT = None


def _jsonable(v):
    return v if isinstance(v, (int, float, str)) or v is None else str(v)


def _col(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def write_xlsx_stdlib(out: str, sheets):
    """Minimal .xlsx writer (standard library only) for Pis without openpyxl: bold header, frozen first row,
    result colours. Opens in Excel, LibreOffice and Google Sheets."""
    import zipfile
    from xml.sax.saxutils import escape as xesc

    def cell(ref, v, style=0):
        st = f' s="{style}"' if style else ""
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return f'<c r="{ref}"{st}><v>{v}</v></c>'
        t = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "?", "" if v is None else str(v))[:32000]
        return f'<c r="{ref}"{st} t="inlineStr"><is><t xml:space="preserve">{xesc(t)}</t></is></c>'

    styles_for = {"PASS": 2, "APPLIED": 2, "FAIL": 3, "NOT APPLIED": 3, "PARTIAL": 3, "LIMIT": 4, "UNVERIFIED": 4,
                  "INFO": 5, "REFUSED": 5, "SKIP": 6, "ERROR": 7}
    names, used = [], set()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for i, (name, rows) in enumerate(sheets, 1):
            nm = re.sub(r"[\[\]:*?/\\]", " ", name)[:31] or f"Sheet{i}"
            while nm in used:
                nm = nm[:28] + f"_{i}"
            used.add(nm)
            names.append(nm)
            widths = {}
            xml_rows = []
            for r_i, row in enumerate(rows, 1):
                cells = []
                for c_i, v in enumerate(row, 1):
                    if v is None or v == "":
                        continue
                    style = 1 if r_i == 1 else styles_for.get(str(v), 0) if isinstance(v, str) and len(v) < 12 else 0
                    cells.append(cell(f"{_col(c_i)}{r_i}", v, style))
                    if r_i <= 400:
                        widths[c_i] = max(widths.get(c_i, 0), min(60, len(str(v))))
                xml_rows.append(f'<row r="{r_i}">{"".join(cells)}</row>')
            cols = "".join(f'<col min="{c}" max="{c}" width="{max(8, w + 2)}" customWidth="1"/>' for c, w in sorted(widths.items()))
            z.writestr(f"xl/worksheets/sheet{i}.xml",
                       '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                       '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                       '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
                       + (f"<cols>{cols}</cols>" if cols else "") + f'<sheetData>{"".join(xml_rows)}</sheetData></worksheet>')
        n = len(names)
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                   + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, n + 1))
                   + "</Types>")
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                   + "".join(f'<sheet name="{xesc(nm, {chr(34): "&quot;"})}" sheetId="{i}" r:id="rId{i}"/>' for i, nm in enumerate(names, 1))
                   + "</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, n + 1))
                   + f'<Relationship Id="rId{n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
        fills = ["C6EFCE", "FFC7CE", "FFEB9C", "DDEBF7", "EDEDED", "F4B183"]
        z.writestr("xl/styles.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'
                   '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
                   f'<fills count="{3 + len(fills)}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
                   '<fill><patternFill patternType="solid"><fgColor rgb="FF305496"/></patternFill></fill>'
                   + "".join(f'<fill><patternFill patternType="solid"><fgColor rgb="FF{c}"/></patternFill></fill>' for c in fills)
                   + '</fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>'
                   f'<cellXfs count="{2 + len(fills)}"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/>'
                   + "".join(f'<xf fontId="2" fillId="{3 + k}" applyFont="1" applyFill="1"/>' for k in range(len(fills)))
                   + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')


def xlsx_to_json(path: str) -> dict:
    """Read any .xlsx (this tool's or Excel's) with the standard library -> {"name", "sheets": {name: rows}}."""
    import zipfile
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
        rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
        out = {}
        for sh in ET.fromstring(z.read("xl/workbook.xml")).find("m:sheets", ns):
            target = rels[sh.get(f"{{{ns['r']}}}id")].lstrip("/")
            target = target if target.startswith("xl/") else "xl/" + target
            rows = []
            for row in ET.fromstring(z.read(target)).iter(f"{{{ns['m']}}}row"):
                vals = {}
                for c in row.findall("m:c", ns):
                    ref = re.match(r"([A-Z]+)", c.get("r", "A"))
                    col = 0
                    for ch in ref.group(1):
                        col = col * 26 + ord(ch) - 64
                    t, v = c.get("t"), c.find("m:v", ns)
                    if t == "s" and v is not None:
                        val = shared[int(v.text)]
                    elif t == "inlineStr":
                        val = "".join(x.text or "" for x in c.iter(f"{{{ns['m']}}}t"))
                    elif v is not None:
                        val = v.text
                        if t not in ("str", "e", "b"):
                            try:
                                f = float(val)
                                val = int(f) if f.is_integer() and "." not in val and "E" not in val.upper() else f
                            except (TypeError, ValueError):
                                pass
                    else:
                        val = ""
                    vals[col] = val
                rows.append([vals.get(i, "") for i in range(1, max(vals) + 1)] if vals else [])
            out[sh.get("name")] = rows
    return {"name": os.path.basename(path), "sheets": out}


def _xl(v):
    if isinstance(v, str):
        v = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "?", v)
        return v[:32000]
    return v


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def flatten(obj, prefix="") -> Dict[str, Any]:
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.update(flatten(v, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out.update(flatten(v, f"{prefix}[{i}]"))
    else:
        out[prefix] = obj
    return out


def first_list(data) -> Optional[list]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list):
                return v
    return None


def tokens_of(data) -> List[str]:
    lst = first_list(data) or []
    out = []
    for it in lst:
        if isinstance(it, dict):
            for k in ("Token", "token", "ID", "Id", "Index"):
                if k in it:
                    out.append(str(it[k]))
                    break
    return out


def pctl(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    k = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
    return round(s[k], 1)


def fill_value(p: Param, n: int = 1, prefix="ZZT"):
    lname = p.name.lower()
    if p.values:
        return p.values[0]
    if p.type == "bool":
        return "False"
    if p.type in ("int", "float"):
        if p.min is not None:
            return _num(p.min)
        return "1" if p.max is None or p.max >= 1 else _num(p.max)
    if p.type in ("datetime",):
        return dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    if "token" in lname or "name" in lname or p.type in ("string", ""):
        v = f"{prefix}{n:04d}"
        if p.maxlen:
            v = v[: p.maxlen]
        return v
    return f"{prefix}{n}"


def concrete(name: str) -> str:
    # templated names like Door.#.Name or <AppID>.X -> first instance
    return re.sub(r"<[^>]+>", "1", name.replace("#", "1"))


# --------------------------------------------------------------------------
# Test suite
# --------------------------------------------------------------------------

class EventStream:
    """Background reader for eventstatus monitordiff / monitor (multipart, boundary SamsungTechwin)."""

    def __init__(self, client: "Client", path: str):
        self.c, self.path = client, path
        self.status = None
        self.error = None
        self.events: List[Tuple[float, dict]] = []
        self.parts = 0
        self.part_times: List[float] = []
        self.t_open = None
        self.first_part_s = None
        self._stop = False
        self._conn = None
        self._lock = threading.Lock()
        self.th = threading.Thread(target=self._run, daemon=True)

    def start(self, wait_first=5.0):
        self.th.start()
        end = time.time() + wait_first
        while time.time() < end and self.parts == 0 and self.error is None and (self.status in (None, 200)):
            time.sleep(0.05)
        return self

    def _run(self):
        self.c.request("GET", self.c.path("system", "deviceinfo", "view"))  # prime digest
        conn = self.c._conn(timeout=10)
        self._conn = conn
        try:
            hdr = {"User-Agent": f"nhp-limits/{VERSION}"}
            if self.c._chal:
                hdr["Authorization"] = self.c.digest_header("GET", self.path, self.c._chal)
            self.t_open = time.time()
            conn.request("GET", self.path, headers=hdr)
            hr = conn.getresponse()
            self.status = hr.status
            if hr.status != 200:
                self.error = f"HTTP {hr.status}"
                return
            ct = hr.getheader("Content-Type") or ""
            m = re.search(r"boundary=\"?([^\";]+)", ct)
            boundary = ("--" + (m.group(1) if m else "SamsungTechwin")).encode()
            try:
                conn.sock.settimeout(None)
            except Exception:
                pass
            buf = b""
            dec = json.JSONDecoder()
            while not self._stop:
                chunk = hr.read1(65536) if hasattr(hr, "read1") else hr.read(4096)
                if not chunk:
                    break
                buf += chunk
                while True:
                    i = buf.find(boundary)
                    j = buf.find(boundary, i + len(boundary)) if i >= 0 else -1
                    # a part is complete when its JSON parses, even before the next boundary arrives
                    start = buf.find(b"{", i if i >= 0 else 0)
                    if start < 0:
                        break
                    end_lim = j if j >= 0 else len(buf)
                    try:
                        obj, used = dec.raw_decode(buf[start:end_lim].decode("utf-8", "replace"))
                    except ValueError:
                        if j >= 0:
                            buf = buf[j:]
                            continue
                        break
                    now = time.time()
                    with self._lock:
                        self.parts += 1
                        self.part_times.append(now)
                        if self.first_part_s is None:
                            self.first_part_s = now - self.t_open
                        for ev in (obj.get("EventStatus") or []) if isinstance(obj, dict) else []:
                            if isinstance(ev, dict):
                                self.events.append((now, ev))
                    consumed = start + len(buf[start:end_lim].decode("utf-8", "replace")[:used].encode("utf-8"))
                    buf = buf[consumed:]
        except Exception as e:
            if not self._stop:
                self.error = f"{type(e).__name__}: {e}"[:150]
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def stop(self):
        self._stop = True
        try:
            if self._conn is not None and self._conn.sock is not None:
                self._conn.sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            if self._conn is not None:
                self._conn.close()
        except Exception:
            pass
        self.th.join(timeout=3)

    def since(self, t0: float) -> List[Tuple[float, dict]]:
        with self._lock:
            return [(t, e) for t, e in self.events if t >= t0]


# capabilities path for each accesscontrol submenu (from a real NHP-P400 capabilities response)
CAP_MAP = {
    "accessschedule": ["Schedule.MaxCount"], "specialdaygroup": ["Schedule.MaxSpecialDayGroups"],
    "accessprofile": ["AccessProfile.MaxCount"], "accessgroup": ["AccessGroup.MaxCount"],
    "accesspoint": ["AccessPoint.MaxCount"], "area": ["AccessPoint.MaxAreas"],
    "authenticationprofile": ["AuthenticationProfile.MaxAuthenticationProfiles"],
    "securitylevel": ["SecurityLevel.MaxSecurityLevels"], "credentialmethod": ["CredentialMethod.MaxCount"],
    "credential": ["Credential.MaxCount"], "door": ["Door.MaxCount"], "credentialreader": ["CredentialReader.MaxCount"],
}
DOOR_STATE_EVENTS = ("AccessControl.DoorMode", "AccessControl.LockPhysicalState",
                     "AccessControl.DoorPhysicalState", "AccessControl.DoorAlarmState")
EXPECT_MODE = {"Access": "Accessed", "Unlock": "Unlocked", "Lock": "Locked", "LockDown": "LockedDown",
               "LockOpen": "LockedOpen", "Block": "Blocked", "DoubleLock": "DoubleLocked"}


class Suite:
    def __init__(self, args, client: Client, rep: Report):
        self.a = args
        self.c = client
        self.rep = rep
        self.cat = Catalog()
        self.devinfo: Dict[str, Any] = {}
        self.caps_flat: Dict[str, Any] = {}
        self.doors_data: List[dict] = []
        self.created: Dict[str, set] = {}
        self.out_dir = os.path.dirname(os.path.abspath(args.out)) or "."

    # ---- generic helpers -------------------------------------------------
    def call(self, cgi, sub, act, params=None, **kw):
        r, res = self.c.sunapi(cgi, sub, act, params, **kw)
        self.rep.err(res, f"{cgi}/{sub}/{act}")
        return r, res

    def healthy(self) -> Tuple[bool, Resp]:
        r, res = self.call("system", "deviceinfo", "view")
        return res.ok, r

    def safe(self, tid, level, name, fn: Callable):
        try:
            fn()
        except KeyboardInterrupt:
            raise
        except Exception as e:
            self.rep.add(tid, level, name, "", "", f"{type(e).__name__}: {e}", "ERROR",
                         traceback.format_exc(limit=3)[-600:])

    # ======================================================================
    # DISCOVERY
    # ======================================================================
    def d01_deviceinfo(self):
        r, res = self.call("system", "deviceinfo", "view")
        if not res.ok:
            self.rep.add("D01", "discovery", "Device info", "Controller answers an authenticated SUNAPI call",
                         "OK", res.label(), "FAIL", "Check host, port, user and password.", r.url, r.short(), r.ms)
            raise SystemExit("Cannot log in to the controller - stopping. " + r.short(200))
        d = res.data if isinstance(res.data, dict) else {}
        if not d and isinstance(res.data, str):
            for line in res.data.splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    d[k.strip()] = v.strip()
        self.devinfo = d
        keys = ["Model", "DeviceType", "FirmwareVersion", "BuildDate", "SerialNumber", "ConnectedMACAddress", "DeviceName"]
        summ = ", ".join(f"{k}={d[k]}" for k in keys if k in d) or _cell(d)[:200]
        self.rep.add("D01", "discovery", "Device info", "Model / firmware / type", "", summ, "INFO",
                     request=r.url, response=r.short(), ms=r.ms)
        self.rep.full("D01", "discovery", "Device info", r)
        for k, v in d.items():
            self.rep.info.append([k, v])

    def d02_attributes(self):
        tried = []
        for p in (f"/{self.c.root}/attributes.cgi", f"/{self.c.root}/attributes.cgi/cgis",
                  f"/{self.c.root}/attributes.cgi/attributes"):
            r = self.c.request("GET", p, headers={"Accept": "application/xml"})
            tried.append(f"{p} -> {r.status or r.error}")
            if r.status == 200 and b"<" in r.body[:200]:
                try:
                    tmp = Catalog().parse(r.text)
                except ET.ParseError as e:
                    tried[-1] += f" (XML error {e})"
                    continue
                for k, v in tmp.cgis.items():
                    self.cat.cgis.setdefault(k, {}).update(v)
                self.cat.attributes.update(tmp.attributes)
                path = os.path.join(self.out_dir, f"attributes-{self.a.host.replace(':', '_')}.xml")
                with open(path, "wb") as f:
                    f.write(r.body)
                if self.cat.cgis and self.cat.attributes:
                    break
        c, s, a, p = self.cat.counts()
        if not c:
            self.rep.add("D02", "discovery", "attributes.cgi (API spec)", "Controller publishes its API spec",
                         "XML with cgis", "; ".join(tried), "FAIL",
                         "Without the spec the view sweep, field and capacity tests have nothing to work from.")
            return
        self.rep.add("D02", "discovery", "attributes.cgi (API spec)", "Controller publishes its API spec",
                     "", f"{c} CGIs, {s} submenus, {a} actions, {p} parameters, {len(self.cat.attributes)} attributes",
                     "INFO", "Raw XML saved next to the report.", "; ".join(tried))
        for cgi, sub, act, ps in self.cat.actions():
            if not ps:
                self.rep.spec.append([cgi, sub, act, "", "", "", "", ""])
            for q in ps:
                self.rep.spec.append([cgi, sub, act, q.name, "Y" if q.req else "", "Y" if q.res else "", q.type, q.spec()])

    def d03_attr_limits(self):
        if not self.cat.attributes:
            self.rep.add("D03", "discovery", "Declared limits in attributes", "", "", "No <attribute> entries", "SKIP")
            return
        n_lim = n_feat = 0
        for k, v in sorted(self.cat.attributes.items()):
            leaf = k.rsplit("/", 1)[-1]
            if _to_num(v) is not None and re.search(r"max|min|limit|count|num|support|total|channel|port|size|length", leaf, re.I):
                self.rep.limit(k, v, "attributes.cgi")
                n_lim += 1
            elif str(v).lower() in ("true", "false"):
                self.rep.features.append([k, v, "attributes.cgi", ""])
                n_feat += 1
            else:
                self.rep.features.append([k, v, "attributes.cgi", ""])
        self.rep.add("D03", "discovery", "Declared limits in attributes", "Numeric max/count attributes",
                     "", f"{n_lim} numeric limits, {len(self.cat.attributes) - n_lim} other properties", "INFO",
                     "See the Limits and Features sheets.")

    def d04_capabilities(self):
        if self.cat.cgis and not self.cat.has("accesscontrol", "capabilities"):
            self.rep.add("D04", "discovery", "Access-control capabilities", "", "", "No accesscontrol/capabilities in spec", "SKIP")
            return
        r, res = self.call("accesscontrol", "capabilities", "view")
        if not res.ok:
            self.rep.add("D04", "discovery", "Access-control capabilities", "accesscontrol/capabilities/view",
                         "OK", res.label(), "FAIL", request=r.url, response=r.short(), ms=r.ms)
            return
        self.caps_flat = flatten(res.data) if isinstance(res.data, (dict, list)) else {}
        nums = 0
        for k, v in self.caps_flat.items():
            if isinstance(v, bool) or str(v).lower() in ("true", "false"):
                self.rep.features.append([k, v, "capabilities", ""])
            elif _to_num(v) is not None:
                self.rep.limit(k, v, "capabilities")
                nums += 1
            else:
                self.rep.features.append([k, v, "capabilities", ""])
        self.rep.full("D04", "discovery", "Access-control capabilities", r)
        self.rep.add("D04", "discovery", "Access-control capabilities", "Declared object counts and features",
                     "", f"{nums} numeric limits, {len(self.caps_flat) - nums} features", "INFO",
                     request=r.url, response=r.short(1500), ms=r.ms)

    def d05_doors(self):
        r, res = self.call("accesscontrol", "door", "view")
        if not res.ok:
            self.rep.add("D05", "discovery", "Doors", "door/view", "OK", res.label(), "FAIL",
                         request=r.url, response=r.short(), ms=r.ms)
            return
        doors = first_list(res.data) or []
        self.doors_data = [d for d in doors if isinstance(d, dict)]
        wired = 0
        for d in self.doors_data:
            io = d.get("IOPort", {}) or {}
            caps = d.get("Capabilities", {}) or {}
            tm = d.get("Timings", {}) or {}
            lock_wired = io.get("Lock", -1) not in (-1, None)
            wired += lock_wired
            self.rep.doors.append([d.get("Token"), d.get("Name"), d.get("Enable"), d.get("Mode"),
                                   "yes" if lock_wired else "NO", io.get("ReaderIn"), io.get("ReaderOut"),
                                   io.get("DoorPositionSwitch"), io.get("RexIn"),
                                   tm.get("ReleaseTime"), tm.get("MaxOpenTime"), tm.get("ExtendedReleaseTime"),
                                   ", ".join(k for k, v in caps.items() if v is True),
                                   ", ".join(k for k, v in caps.items() if v is False)])
            for k, v in tm.items():
                self.rep.limit(f"Door {d.get('Token')} Timings.{k}", v, "door/view", "seconds")
        self.rep.limit("Doors configured", len(self.doors_data), "door/view", f"{wired} with a lock output wired")
        dm, dk = self._declared_max("door")
        if dm is not None and dm != len(self.doors_data):
            self.rep.add("D05c", "discovery", "Doors vs declared", "door/view count matches capabilities Door.MaxCount",
                         dm, f"{len(self.doors_data)} doors in door/view", "INFO", f"{dk}={dm}")
        self.rep.full("D05", "discovery", "Doors", r)
        self.rep.add("D05", "discovery", "Doors", "Doors, wiring and per-door command support", "",
                     f"{len(self.doors_data)} doors, {wired} with a lock output wired", "INFO",
                     "See the Doors sheet.", r.url, r.short(800), r.ms)
        cmd = [p for p in self.cat.params("accesscontrol", "door", "control") if p.name.lower() == "command"]
        if cmd and cmd[0].values:
            self.rep.features.append(["door/control Command values", ", ".join(cmd[0].values), "attributes.cgi", ""])
        for d in self.doors_data:
            caps = d.get("Capabilities", {}) or {}
            if caps.get("AccessTimingOverride") is False:
                self.rep.add("D05b", "discovery", f"Door {d.get('Token')} release-time override",
                             "Can a release command carry its own unlock time?", "", "AccessTimingOverride=false",
                             "LIMIT", "Release time is fixed per door (Timings.ReleaseTime); a request cannot change it.")
                break

    def d06_missing(self):
        if not self.cat.cgis:
            return
        ac = self.cat.cgis.get("accesscontrol", {})
        subs = sorted(ac)
        expect = {
            "users / cardholders": r"^(user|users|cardholder|person|people)$",
            "credentials (cards, PINs)": r"^(credential|credentials|card|cards)$",
            "access events / log": r"(event|log|history|transaction)",
            "anti-passback": r"(antipassback|passback|apb)",
            "interlock / mantrap": r"(interlock|mantrap)",
            "elevator / floors": r"(elevator|floor)",
            "first-person-in / unlock schedule": r"(firstperson|firstin|unlockschedule|doorschedule)",
        }
        found, missing = [], []
        all_subs = [(cgi, s) for cgi, ss in self.cat.cgis.items() for s in ss]
        for label, rx in expect.items():
            hits = [f"{cgi}/{s}" for cgi, s in all_subs if re.search(rx, s, re.I)]
            (found if hits else missing).append(f"{label}: {', '.join(hits)}" if hits else label)
        self.rep.features.append(["accesscontrol submenus", ", ".join(subs), "attributes.cgi", ""])
        self.rep.add("D06", "discovery", "Missing ACS functions",
                     "Typical access-control functions with no SUNAPI menu (likely managed only by the host / ACS server)",
                     "", ("Not exposed: " + "; ".join(missing)) if missing else "All present",
                     "LIMIT" if missing else "INFO", ("Present: " + "; ".join(found)) if found else "")

    def d07_field_limits(self):
        if not self.cat.cgis:
            return
        n = 0
        for cgi, sub, act, ps in self.cat.actions():
            if cgi != "accesscontrol" or act not in ("add", "update", "set", "control", "add/update"):
                continue
            for p in ps:
                if p.req or p.type in ("string", "int", "csv"):
                    if p.maxlen is not None or p.max is not None:
                        self.rep.limit(f"{sub}/{act} {p.name}", p.spec(), "attributes.cgi", p.type)
                        n += 1
        self.rep.add("D07", "discovery", "Declared field limits", "String lengths and number ranges on writable access-control fields",
                     "", f"{n} declared field limits", "INFO", "Listed on the Limits sheet; full detail on API spec.")

    def d08_view_sweep(self):
        if not self.cat.cgis:
            return
        skip_sub = re.compile(r"(monitor|stream|download|backup|snapshot|log|firmware|upgrade|reboot|factory)", re.I)
        ok = ng = 0
        targets = [(cgi, sub, act, ps) for cgi, sub, act, ps in self.cat.actions() if act == "view"]
        print(f"    sweeping {len(targets)} view commands...")
        for cgi, sub, act, ps in targets:
            if skip_sub.search(sub) and not self.a.sweep_all:
                self.rep.views.append([cgi, sub, act, "", "SKIPPED (stream/log/heavy - use --sweep-all)", "", "", "", ""])
                continue
            params = {}
            for p in ps:
                if p.req:
                    params[concrete(p.name)] = fill_value(p)
            r, res = self.call(cgi, sub, act, params)
            if res.ok:
                ok += 1
            else:
                ng += 1
            self.rep.views.append([cgi, sub, act, urllib.parse.urlencode(params), "OK" if res.ok else "NG",
                                   "" if res.ok else res.label(), r.status or r.error, len(r.body), round(r.ms, 1)])
        self.rep.add("D08", "discovery", "View sweep", "Every read command in the spec answers",
                     f"{len(targets)} views", f"{ok} OK, {ng} NG", "PASS" if ng == 0 else "INFO",
                     "NG on a view usually means a required parameter needs a real value, or the feature is not licensed / wired. See View sweep sheet.")

    # ======================================================================
    # PROTOCOL
    # ======================================================================
    def protocol(self):
        L = "protocol"
        self.safe("P01", L, "Plain HTTP", self.p01_http)
        self.safe("P02", L, "HTTPS certificate & TLS", self.p02_tls)
        self.safe("P03", L, "Legacy TLS versions", self.p03_old_tls)
        self.safe("P04", L, "Auth schemes offered", self.p04_challenge)
        self.safe("P05", L, "Basic auth (phones / simple clients)", self.p05_basic)
        self.safe("P06", L, "Digest algorithms", self.p06_digest_algs)
        self.safe("P07", L, "Digest nonce reuse", self.p07_nonce)
        self.safe("P08", L, "HTTP keep-alive", self.p08_keepalive)
        self.safe("P09", L, "POST instead of GET", self.p09_post)
        self.safe("P10", L, "Maximum URL length", self.p10_urllen)
        self.safe("P11", L, "Response format", self.p11_format)

    def p01_http(self):
        path = self.c.path("system", "deviceinfo", "view")
        r = self.c.raw("GET", path, scheme="http", port=self.a.http_port, timeout=5)
        loc = r.header("Location") or ""
        if r.error:
            m, res = f"Port {self.a.http_port} closed / no answer ({r.error[:80]})", "INFO"
        elif r.status in (301, 302, 303, 307, 308):
            m, res = f"HTTP {r.status} redirect to {loc}", "INFO"
        elif r.status == 401:
            m, res = "Plain HTTP accepted (asks for login)", "INFO"
        else:
            m, res = f"HTTP {r.status}", "INFO"
        self.rep.add("P01", "protocol", "Plain HTTP", "Does the controller serve SUNAPI over plain HTTP?", "",
                     m, res, "Simple clients (phones, PLCs) often support only plain HTTP.", r.url, r.short(150), r.ms)
        self.rep.features.append(["Plain HTTP", m, "measured", ""])

    def p02_tls(self):
        if self.c.scheme != "https":
            self.rep.add("P02", "protocol", "HTTPS certificate & TLS", "", "", "Not using HTTPS", "SKIP")
            return
        t0 = time.perf_counter()
        with socket.create_connection((self.c.host, self.c.port), timeout=self.c.timeout) as s:
            with _unverified_ctx().wrap_socket(s, server_hostname=self.c.host) as ss:
                ver, cipher, der = ss.version(), ss.cipher(), ss.getpeercert(binary_form=True)
        ms = (time.perf_counter() - t0) * 1000
        info = {}
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as f:
                f.write(ssl.DER_cert_to_PEM_cert(der))
                pem = f.name
            info = ssl._ssl._test_decode_cert(pem)  # type: ignore[attr-defined]
            os.unlink(pem)
        except Exception:
            pass
        subj = ", ".join("=".join(x) for t in info.get("subject", ()) for x in t)
        iss = ", ".join("=".join(x) for t in info.get("issuer", ()) for x in t)
        self_signed = bool(subj) and subj == iss
        try:
            ssl.create_default_context().wrap_socket(socket.create_connection((self.c.host, self.c.port), timeout=5),
                                                     server_hostname=self.c.host).close()
            trusted = True
        except Exception:
            trusted = False
        m = (f"{ver}, {cipher[0] if cipher else ''}; cert subject [{subj}] issuer [{iss}]; "
             f"valid {info.get('notBefore', '?')} -> {info.get('notAfter', '?')}; "
             f"{'self-signed' if self_signed else 'CA-issued'}; trusted by this PC: {'yes' if trusted else 'NO'}")
        self.rep.add("P02", "protocol", "HTTPS certificate & TLS", "TLS version, cipher, certificate", "", m,
                     "LIMIT" if not trusted else "INFO",
                     "An untrusted certificate breaks clients that cannot skip verification (many phones, some integrations)." if not trusted else "",
                     ms=ms)
        self.rep.features.append(["TLS negotiated", f"{ver} {cipher[0] if cipher else ''}", "measured", ""])
        self.rep.features.append(["Certificate", f"{'self-signed' if self_signed else 'CA'}; expires {info.get('notAfter', '?')}", "measured", ""])

    def p03_old_tls(self):
        if self.c.scheme != "https":
            return
        out = []
        for label, v in (("TLS 1.0", ssl.TLSVersion.TLSv1), ("TLS 1.1", ssl.TLSVersion.TLSv1_1),
                         ("TLS 1.2", ssl.TLSVersion.TLSv1_2), ("TLS 1.3", ssl.TLSVersion.TLSv1_3)):
            try:
                ctx = _unverified_ctx(v, v)
                with socket.create_connection((self.c.host, self.c.port), timeout=5) as s:
                    with ctx.wrap_socket(s, server_hostname=self.c.host) as ss:
                        out.append(f"{label}: accepted ({ss.version()})")
            except ssl.SSLError as e:
                msg = str(e)
                who = "this PC cannot offer it" if re.search(r"no protocols available|unsupported protocol|NO_PROTOCOLS", msg, re.I) else "refused"
                out.append(f"{label}: {who}")
            except Exception as e:
                out.append(f"{label}: {type(e).__name__}")
        weak = [o for o in out if o.startswith(("TLS 1.0", "TLS 1.1")) and "accepted" in o]
        self.rep.add("P03", "protocol", "Legacy TLS versions", "Which TLS versions the controller accepts", "",
                     "; ".join(out), "LIMIT" if weak else "INFO",
                     "Old TLS accepted - security finding." if weak else "'this PC cannot offer it' = the test PC's OpenSSL, not the controller.")

    def p04_challenge(self):
        r = self.c.request("GET", self.c.path("system", "deviceinfo", "view"), auth="none")
        ch = parse_challenges(r.header_all("WWW-Authenticate"))
        desc = "; ".join(f"{c['scheme']}" + (f" alg={c.get('algorithm', 'MD5')}" if c["scheme"] == "digest" else "")
                         + (f" qop={c['qop']}" if c.get("qop") else "") + (f" realm={c['realm']}" if c.get("realm") else "")
                         for c in ch) or "(none)"
        self.offered = ch
        res = "PASS" if r.status == 401 else "FAIL"
        self.rep.add("P04", "protocol", "Auth schemes offered", "Unauthenticated request is refused and what login types are offered",
                     "401 + Digest", f"HTTP {r.status or r.error}; {desc}", res,
                     "" if res == "PASS" else "Controller answered WITHOUT a login - security finding.", r.url, r.short(120), r.ms)
        self.rep.features.append(["Auth offered", desc, "measured", ""])

    def p05_basic(self):
        r = self.c.request("GET", self.c.path("system", "deviceinfo", "view"), auth="basic")
        acc = r.status == 200 and parse_sunapi(r).ok
        self.rep.add("P05", "protocol", "Basic auth (phones / simple clients)",
                     "Does HTTP Basic (user:pass@host) work? Yealink URL keys and many simple clients only do Basic.",
                     "", "Basic ACCEPTED" if acc else f"Basic refused (HTTP {r.status or r.error})",
                     "INFO" if acc else "LIMIT",
                     "Simple clients can call the controller directly." if acc else
                     "Clients that only do Basic auth (e.g. Yealink URL keys) need a relay. Note: 1 login attempt used.",
                     r.url, r.short(120), r.ms)

    def p06_digest_algs(self):
        algs = sorted({c.get("algorithm", "MD5") for c in getattr(self, "offered", []) if c["scheme"] == "digest"}) or ["MD5"]
        out = []
        for alg in algs:
            r = self.c.request("GET", self.c.path("system", "deviceinfo", "view"), alg=alg)
            out.append(f"{alg}: {'works' if parse_sunapi(r).ok else f'fails (HTTP {r.status})'}")
        self.rep.add("P06", "protocol", "Digest algorithms", "Each offered Digest algorithm logs in", "", "; ".join(out),
                     "PASS" if all("works" in o for o in out) else "FAIL")

    def p07_nonce(self):
        path = self.c.path("system", "deviceinfo", "view")
        r = self.c.request("GET", path, auth="none")
        ch = self.c._pick(parse_challenges(r.header_all("WWW-Authenticate")))
        if not ch:
            self.rep.add("P07", "protocol", "Digest nonce reuse", "", "", "No Digest challenge", "SKIP")
            return
        n, limit, t0, stale_at, why = 0, self.a.nonce_max, time.time(), None, ""
        for i in range(1, limit + 1):
            rr = self.c.raw("GET", path, headers={"Authorization": self.c.digest_header("GET", path, ch, nc=i)})
            if rr.status == 200:
                n = i
                continue
            stale_at = i
            why = f"HTTP {rr.status}" + (" stale=true" if "stale=true" in (" ".join(rr.header_all("WWW-Authenticate"))).lower() else "")
            break
        el = round(time.time() - t0, 1)
        if stale_at:
            m, res = f"Nonce accepted {n} times, then {why} after {el}s", "LIMIT"
        else:
            m, res = f"Nonce still valid after {n} uses / {el}s (test cap {limit})", "INFO"
        self.rep.add("P07", "protocol", "Digest nonce reuse",
                     "How many requests one login challenge covers (affects request rate and relays)", "", m, res,
                     "nonce never reused = every request costs two round trips." if n <= 1 else "")
        self.rep.limit("Digest nonce reuse count", n if stale_at else f">={n}", "measured", why)

    def p08_keepalive(self):
        path = self.c.path("system", "deviceinfo", "view")
        conn = self.c._conn()
        ok = 0
        notes = []
        try:
            first = self.c.raw("GET", path, conn=conn)
            ch = self.c._pick(parse_challenges(first.header_all("WWW-Authenticate"))) or self.c._chal
            for i in range(1, 6):
                hdr = {"Authorization": self.c.digest_header("GET", path, ch, nc=i)} if ch else {}
                rr = self.c.raw("GET", path, headers=hdr, conn=conn)
                if rr.error:
                    notes.append(f"request {i}: {rr.error[:60]}")
                    break
                if rr.status == 200:
                    ok += 1
                if (rr.header("Connection") or "").lower() == "close":
                    notes.append(f"server sent Connection: close on request {i}")
                    break
        finally:
            conn.close()
        self.rep.add("P08", "protocol", "HTTP keep-alive", "Several requests over one TCP/TLS connection", "5 on one connection",
                     f"{ok}/5 succeeded on one connection", "PASS" if ok == 5 else "LIMIT", "; ".join(notes))

    def p09_post(self):
        path = self.c.path("system", "deviceinfo", "view")
        r = self.c.request("POST", path, body=b"", headers={"Content-Type": "application/x-www-form-urlencoded"})
        res = parse_sunapi(r)
        self.rep.add("P09", "protocol", "POST instead of GET", "Same read command sent as POST", "",
                     "POST works" if res.ok else f"POST refused: {res.label()}", "INFO", "", r.url, r.short(120), r.ms)

    def p10_urllen(self):
        base = self.c.path("system", "deviceinfo", "view")
        last_ok, fail = 0, None
        for size in self.a.url_sizes:
            pad = "A" * max(0, size - len(base) - 8)
            path = f"{base}&ZZPad={pad}"
            r = self.c.request("GET", path)
            http_ok = (r.error is None and r.status in (200,))
            if http_ok:
                last_ok = len(path)
            else:
                fail = f"{len(path)} chars -> {r.error or f'HTTP {r.status}'}"
                break
        m = f"Largest URL answered: {last_ok} chars" + (f"; first failure: {fail}" if fail else " (no HTTP-level failure up to test max)")
        self.rep.add("P10", "protocol", "Maximum URL length", "Longest request line the web server accepts (matters for long CSV / bulk params)",
                     "", m, "LIMIT" if fail else "INFO",
                     "A SUNAPI 'NG unknown parameter' still counts as answered; only HTTP/network failures count as the limit.")
        self.rep.limit("Max URL length (chars)", last_ok if fail else f">={last_ok}", "measured", fail or "")

    def p11_format(self):
        path = self.c.path("system", "deviceinfo", "view")
        rj = self.c.request("GET", path, headers={"Accept": "application/json"})
        saved = self.c.json_accept
        self.c.json_accept = False
        try:
            rt = self.c.request("GET", path)
        finally:
            self.c.json_accept = saved
        kind = lambda r: "JSON" if r.text.strip()[:1] in "{[" else ("text" if r.status == 200 else f"HTTP {r.status}")
        self.rep.add("P11", "protocol", "Response format", "Format with Accept: application/json vs without", "",
                     f"with Accept JSON -> {kind(rj)}; without -> {kind(rt)}", "INFO")

    # ======================================================================
    # VALIDATION
    # ======================================================================
    def validation(self):
        L = "validation"
        door_ok = self.cat.has("accesscontrol", "door", "control") or not self.cat.cgis
        if door_ok:
            self.safe("V01", L, "Door control: unknown token", lambda: self.v_expect_ng(
                "V01", "Door control: unknown token", "accesscontrol", "door", "control",
                {"Token": "ZZT_NOPE", "Command": "ZZT_BAD"}, "Token that does not exist (command is also invalid, so nothing can move)"))
            tok = self.a.door_token or (self.doors_data[0].get("Token") if self.doors_data else "1")
            self.safe("V02", L, "Door control: invalid command", lambda: self.v_expect_ng(
                "V02", "Door control: invalid command", "accesscontrol", "door", "control",
                {"Token": tok, "Command": "ZZT_BAD"}, "Real door, command not in the enum"))
            self.safe("V03", L, "Door control: token over 32 chars", lambda: self.v_expect_ng(
                "V03", "Door control: token over 32 chars", "accesscontrol", "door", "control",
                {"Token": "Z" * 33, "Command": "ZZT_BAD"}, "Token length limit"))
            self.safe("V04", L, "Door control: missing Command", lambda: self.v_expect_ng(
                "V04", "Door control: missing Command", "accesscontrol", "door", "control",
                {"Token": "ZZT_NOPE"}, "Required parameter missing"))
        self.safe("V05", L, "Unknown submenu", lambda: self.v_expect_ng(
            "V05", "Unknown submenu", "accesscontrol", "zztnosuchmenu", "view", None, "Error for a submenu that does not exist"))
        self.safe("V06", L, "Unknown action", lambda: self.v_expect_ng(
            "V06", "Unknown action", "accesscontrol", "door", "zztnosuchaction", None, "Error for an action that does not exist"))
        self.safe("V07", L, "Unknown CGI", lambda: self.v_expect_ng(
            "V07", "Unknown CGI", "zztnosuchcgi", "door", "view", None, "Error for a CGI that does not exist"))
        self.safe("V08", L, "Unknown extra parameter", lambda: self.v_extra_param())
        self.safe("V09", L, "Out-of-range / bad enum on read commands", self.v09_ranges)
        self.safe("V10", L, "Hostile characters", self.v10_hostile)
        self.safe("V11", L, "Controller healthy after validation", lambda: self.health("V11", "validation"))

    def v_expect_ng(self, tid, name, cgi, sub, act, params, checks):
        r, res = self.call(cgi, sub, act, params)
        self.rep.add(tid, "validation", name, checks, "NG with an error code",
                     res.label(), "PASS" if not res.ok else "FAIL",
                     "" if not res.ok else "Controller ACCEPTED an invalid request.", r.url, r.short(200), r.ms)

    def v_extra_param(self):
        r, res = self.call("system", "deviceinfo", "view", {"ZZTUnknown": "1"})
        self.rep.add("V08", "validation", "Unknown extra parameter", "Read command with an extra parameter it does not define", "",
                     "Ignored (OK)" if res.ok else f"Rejected: {res.label()}", "INFO",
                     "Strict controllers reject unknown parameters - integrations must send exactly the documented set." if not res.ok else "",
                     r.url, r.short(150), r.ms)

    def v09_ranges(self):
        done = 0
        for cgi, sub, act, ps in self.cat.actions():
            if act != "view" or done >= 6:
                continue
            for p in ps:
                if not p.req and p.type not in ("int", "enum"):
                    continue
                bad = None
                if p.type == "int" and p.max is not None:
                    bad = _num(p.max + 1)
                elif p.type == "enum" and p.values:
                    bad = "ZZT_BAD"
                if bad is None:
                    continue
                params = {concrete(q.name): fill_value(q) for q in ps if q.req}
                params[concrete(p.name)] = bad
                r, res = self.call(cgi, sub, act, params)
                self.rep.add(f"V09.{done + 1}", "validation", f"{sub}/{act} {p.name}={bad}",
                             f"Value outside declared {p.spec()[:60]}", "NG", res.label(),
                             "PASS" if not res.ok else "FAIL",
                             "" if not res.ok else "Out-of-spec value accepted.", r.url, r.short(150), r.ms)
                done += 1
                break
        if not done:
            self.rep.add("V09", "validation", "Out-of-range / bad enum on read commands", "", "", "No suitable view parameters in spec", "SKIP")

    def v10_hostile(self):
        cases = ["../../etc/passwd", "<script>x</script>", "' OR '1'='1", "%00", "éü中", "A" * 512]
        bad = []
        for i, v in enumerate(cases, 1):
            r, res = self.call("accesscontrol", "door", "view", {"Token": v})
            if r.error or r.status >= 500:
                bad.append(f"case {i}: {r.error or r.status}")
        ok, hr = self.healthy()
        self.rep.add("V10", "validation", "Hostile characters", "Path traversal, script, SQL, NUL, unicode, 512-char values in door view Token",
                     "NG or empty, no crash", "No server errors" if not bad else "; ".join(bad),
                     "PASS" if not bad and ok else "FAIL", "" if ok else "Controller stopped answering afterwards!")

    def health(self, tid, level):
        ok, r = self.healthy()
        self.rep.add(tid, level, "Controller healthy", "Device info still answers", "OK", "OK" if ok else r.short(120),
                     "PASS" if ok else "FAIL", ms=r.ms)

    # ======================================================================
    # LOAD
    # ======================================================================
    def load(self):
        L = "load"
        self.safe("L01", L, "Sequential latency (device info)", lambda: self.l_seq("L01", "system", "deviceinfo", "view", None, self.a.seq_count))
        self.safe("L02", L, "Sequential latency (door view)", lambda: self.l_seq("L02", "accesscontrol", "door", "view", None, max(10, self.a.seq_count // 2)))
        self.safe("L03", L, "Concurrent connections", self.l03_concurrency)
        self.safe("L04", L, "Event monitor streams", self.l04_monitor)
        self.safe("L05", L, "Controller healthy after load", lambda: self.health("L05", "load"))

    def l_seq(self, tid, cgi, sub, act, params, n):
        ms, errs = [], 0
        t0 = time.time()
        for _ in range(n):
            r, res = self.call(cgi, sub, act, params)
            if res.ok:
                ms.append(r.ms)
            else:
                errs += 1
        el = time.time() - t0
        rate = round(n / el, 1) if el else None
        m = f"{n} requests: p50 {pctl(ms, 50)} ms, p95 {pctl(ms, 95)} ms, max {round(max(ms), 1) if ms else '-'} ms, {rate}/s, {errs} errors"
        self.rep.add(tid, "load", f"Sequential latency ({sub} {act})", "Response time one request at a time", "", m,
                     "PASS" if errs == 0 else "FAIL")
        self.rep.limit(f"{sub}/{act} p95 latency (ms)", pctl(ms, 95), "measured", f"{n} sequential")
        self.rep.limit(f"{sub}/{act} sequential rate (req/s)", rate, "measured", "incl. Digest + TLS per request")

    def l03_concurrency(self):
        levels = [n for n in (1, 2, 4, 8, 16, 32, 64, 128) if n <= self.a.concurrency_max]
        path = self.c.path("system", "deviceinfo", "view")
        best, first_fail, rows = 0, None, []
        for n in levels:
            def worker(_):
                out = []
                for _ in range(3):
                    # own login per request: shared nonce counters would race across threads
                    r = self.c.request("GET", path, user=self.c.user, password=self.c.password)
                    out.append((r.status == 200 and parse_sunapi(r).ok, r.ms, r.error or (r.status if r.status != 200 else "")))
                return out
            with ThreadPoolExecutor(max_workers=n) as ex:
                res = [x for lst in ex.map(worker, range(n)) for x in lst]
            ok = sum(1 for x in res if x[0])
            kinds = sorted({str(x[2])[:40] for x in res if not x[0]})
            p95 = pctl([x[1] for x in res if x[0]], 95)
            rows.append(f"{n} parallel: {ok}/{len(res)} ok, p95 {p95} ms" + (f" ({', '.join(kinds)})" if kinds else ""))
            if ok == len(res):
                best = n
            elif first_fail is None:
                first_fail = n
                if ok < len(res) * 0.5:
                    break
            time.sleep(0.5)
        self.rep.add("L03", "load", "Concurrent connections", "Parallel clients each sending 3 requests",
                     "", " | ".join(rows), "LIMIT" if first_fail else "INFO",
                     f"All succeeded up to {best} parallel" + (f"; failures from {first_fail}" if first_fail else f" (test max {self.a.concurrency_max})"))
        self.rep.limit("Concurrent clients, all OK", best if first_fail else f">={best}", "measured",
                       f"failures from {first_fail}" if first_fail else "")
        ok, _ = self.healthy()
        if not ok:
            time.sleep(5)

    def l04_monitor(self):
        acts = [(cgi, sub, act) for cgi, sub, act, _ in self.cat.actions() if act in ("monitordiff", "monitor")]
        cand = sorted(acts, key=lambda x: x[2] != "monitordiff")
        if not cand:
            cand = [("eventstatus", "eventstatus", "monitordiff")]
        if not cand:
            self.rep.add("L04", "load", "Event monitor streams", "", "", "No monitor action in spec", "SKIP")
            return
        cgi, sub, act = cand[0]
        path = self.c.path(cgi, sub, act, {"SchemaBased": "True"} if act == "monitordiff" else None)
        self.healthy()
        held, err = [], None
        for i in range(self.a.monitor_max):
            conn = self.c._conn(timeout=4)
            try:
                hdr = {"Authorization": self.c.digest_header("GET", path, self.c._chal)} if self.c._chal else {}
                hdr["User-Agent"] = f"nhp-limits/{VERSION}"
                conn.request("GET", path, headers=hdr)
                hr = conn.getresponse()
                if hr.status != 200:
                    err = f"stream {i + 1}: HTTP {hr.status}"
                    conn.close()
                    break
                try:
                    hr.read1(64) if hasattr(hr, "read1") else hr.read(1)
                except socket.timeout:
                    pass
                held.append((conn, hr))
            except Exception as e:
                err = f"stream {i + 1}: {type(e).__name__} {e}"[:120]
                conn.close()
                break
        n = len(held)
        for conn, _ in held:
            try:
                conn.close()
            except Exception:
                pass
        time.sleep(1)
        self.rep.add("L04", "load", "Event monitor streams", f"How many {cgi}/{sub}/{act} streams can be open at once",
                     "", f"{n} streams held" + (f"; then {err}" if err else f" (test max {self.a.monitor_max})"),
                     "LIMIT" if err else "INFO", "Each listener uses one stream - the Cloud Connector already holds one on a claimed controller, so add 1 to this count for the true total.")
        self.rep.limit("Simultaneous event monitor streams", n if err else f">={n}", "measured", err or "")

    # ======================================================================
    # CONNECTOR (read-only replay of what the Cloud Connector calls)
    # ======================================================================
    def connector(self):
        L = "connector"
        reads = [
            ("N01", "Device info", "system", "deviceinfo", "view", None),
            ("N02", "Capabilities", "accesscontrol", "capabilities", "view", None),
            ("N03", "Event status (SchemaBased)", "eventstatus", "eventstatus", "check", {"SchemaBased": "True"}),
            ("N04", "Host communication", "accesscontrol", "hostcommunication", "view", None),
            ("N05", "Date / time zone", "system", "date", "view", None),
            ("N06", "Alarm inputs", "eventsources", "alarminput", "view", None),
            ("N07", "Credential readers", "accesscontrol", "credentialreader", "view", None),
        ]
        for tid, name, cgi, sub, act, params in reads:
            self.safe(tid, L, name, lambda t=tid, n=name, c=cgi, su=sub, a=act, p=params: self.n_read(t, n, c, su, a, p))
        self.safe("N08", L, "monitordiff stream", self.n08_stream)
        self.rep.add("N09", L, "Connector writes (not sent)",
                     "Calls the connector makes that change settings it owns - listed, not tested", "", 
                     "system/date set; eventsources/alarminput set; accesscontrol/credentialreader set; "
                     "accesscontrol/hostcommunication control CloudConnectionState=Connected", "SKIP",
                     "Sending these from a test PC would fight a connected Cloud Connector.")

    def n_read(self, tid, name, cgi, sub, act, params):
        r, res = self.call(cgi, sub, act, params)
        size = len(r.body)
        detail = ""
        if res.ok and isinstance(res.data, dict):
            if sub == "eventstatus":
                evs = res.data.get("EventStatus") or []
                cnt = {}
                for e in evs:
                    if isinstance(e, dict):
                        cnt[e.get("EventName")] = cnt.get(e.get("EventName"), 0) + 1
                detail = f"{len(evs)} states: " + ", ".join(f"{k.split('.')[-1]} x{v}" for k, v in sorted(cnt.items()))
                self.rep.limit("eventstatus check size (bytes)", size, "measured", f"{len(evs)} entries")
            elif sub == "hostcommunication":
                flat = flatten(res.data)
                self.cloud = {k: v for k, v in flat.items() if re.search(r"cloud|connect|state|host|enable", k, re.I)}
                detail = _cell(self.cloud)[:300]
                for k, v in self.cloud.items():
                    self.rep.features.append([f"hostcommunication {k}", v, "connector", ""])
            else:
                detail = _cell(res.data)[:300]
        self.rep.full(tid, "connector", name, r)
        self.rep.add(tid, "connector", name, f"{cgi}/{sub}/{act} - a call the Cloud Connector makes", "OK",
                     (res.label() + (f"; {size} bytes; {detail}" if res.ok else "")), "PASS" if res.ok else "FAIL",
                     "" if res.ok else "The Cloud Connector depends on this call.", r.url, r.short(1500), r.ms)

    def n08_stream(self):
        path = self.c.path("eventstatus", "eventstatus", "monitordiff", {"SchemaBased": "True"})
        es = EventStream(self.c, path).start(wait_first=8)
        busy_note = ""
        if es.status == 503 or (es.status not in (None, 200)):
            es.stop()
            t_wait = time.time()
            for _ in range(10):  # streams closed by L04 may take a while to be released
                time.sleep(2)
                es = EventStream(self.c, path).start(wait_first=8)
                if es.status == 200:
                    break
                es.stop()
            busy_note = f" (stream slots took {round(time.time() - t_wait)}s to free up after earlier streams closed)"
            self.rep.limit("Stream slot release after client disconnect (s)", round(time.time() - t_wait), "measured", "")
        time.sleep(self.a.stream_secs)
        es.stop()
        if es.status != 200 or es.parts == 0:
            self.rep.add("N08", "connector", "monitordiff stream", "The event stream the Cloud Connector holds open", "parts arrive",
                         f"{es.error or ('HTTP ' + str(es.status))}; {es.parts} parts", "FAIL",
                         "Without this stream the cloud gets no door / reader events.")
            return
        names = {}
        for _, e in es.events:
            names[e.get("EventName")] = names.get(e.get("EventName"), 0) + 1
        gaps = [round(b - a, 2) for a, b in zip(es.part_times, es.part_times[1:])]
        for t, e in es.events[:300]:
            self.rep.events.append(["N08 stream", round(t - es.t_open, 3), e.get("EventName"), _cell(e.get("Source")),
                                    _cell(e.get("Data")), e.get("Time")])
        self.rep.add("N08", "connector", "monitordiff stream",
                     f"Open the stream for {self.a.stream_secs}s like the Cloud Connector does", "first part quickly",
                     f"first part after {round(es.first_part_s, 2)}s; {es.parts} parts, {len(es.events)} events; "
                     f"gap between parts max {max(gaps) if gaps else '-'}s; " + ", ".join(f"{k.split('.')[-1]} x{v}" for k, v in sorted(names.items(), key=lambda kv: str(kv[0]))),
                     "PASS", "First part = full current state. With no activity, the gap shows whether the controller sends keep-alives. Events sheet lists them." + busy_note)
        self.rep.limit("monitordiff first part (s)", round(es.first_part_s, 2), "measured", "")
        self.rep.limit("monitordiff initial state entries", len(es.since(es.part_times[0])) if es.part_times else 0, "measured", "")

    # ======================================================================
    # DOOR (hardware)
    # ======================================================================
    def door(self):
        L = "door"
        if not self.a.door_token:
            self.rep.add("H00", L, "Door tests", "", "", "No --door-token given", "SKIP")
            return
        if not self.doors_data:
            r, res = self.call("accesscontrol", "door", "view")
            self.doors_data = [d for d in (first_list(res.data) or []) if isinstance(d, dict)]
        self.door_info = next((d for d in self.doors_data if str(d.get("Token")) == str(self.a.door_token)), {})
        self.release_s = float((self.door_info.get("Timings") or {}).get("ReleaseTime") or 5)
        self.safe("H01", L, "Door state probe", self.h01_probe)
        self.safe("H02", L, "Momentary release (Access)", self.h02_access)
        self.safe("H03", L, "Repeated release", self.h03_repeat)
        self.safe("H04", L, "Burst of releases", self.h04_burst)
        self.safe("H05", L, "Other door commands", self.h05_commands)
        self.safe("H06", L, "Command on unwired door", self.h06_unwired)
        self.safe("H07", L, "Extra timing parameter", self.h07_timing)
        self.safe("H09", L, "Event latency (what the Cloud Connector sees)", self.h09_event_latency)
        self.safe("H08", L, "Controller healthy after door tests", lambda: self.health("H08", "door"))

    def _door_state(self, token=None) -> Optional[Dict[str, Any]]:
        """Door state as the Cloud Connector sees it: eventstatus check SchemaBased=True, entries for this door."""
        tok = str(token or self.a.door_token)
        r, res = self.c.sunapi("eventstatus", "eventstatus", "check", {"SchemaBased": "True"})
        if not res.ok or not isinstance(res.data, dict) or not isinstance(res.data.get("EventStatus"), list):
            return None
        st = {}
        for ev in res.data["EventStatus"]:
            if not isinstance(ev, dict) or ev.get("EventName") not in DOOR_STATE_EVENTS:
                continue
            if str((ev.get("Source") or {}).get("DoorToken")) != tok:
                continue
            for k, v in (ev.get("Data") or {}).items():
                st[f"{ev['EventName'].split('.')[-1]}.{k}"] = v
        return st or None

    def _state(self) -> Optional[str]:
        ds = self._door_state()
        if ds:
            return json.dumps(ds, sort_keys=True)
        tok = self.a.door_token
        probes = []
        if self.cat.has("accesscontrol", "door", "check") or not self.cat.cgis:
            probes.append(("accesscontrol", "door", "check", {"Token": tok}))
        if self.cat.has("eventstatus", "eventstatus", "check"):
            probes.append(("eventstatus", "eventstatus", "check", None))
        for cgi, sub, act, p in probes:
            r, res = self.c.sunapi(cgi, sub, act, p)
            if res.ok and res.data is not None:
                data = res.data
                if isinstance(data, (dict, list)):
                    flat = {k: v for k, v in flatten(data).items()
                            if not re.search(r"time|date|stamp|seq|count", k, re.I)}
                    door_keys = {k: v for k, v in flat.items() if re.search(r"door|lock|mode|state|token", k, re.I)}
                    return json.dumps(door_keys or flat, sort_keys=True)[:600]
                return str(data)[:600]
        return None

    def h01_probe(self):
        s = self._state()
        self.state_ok = s is not None
        self.rep.add("H01", "door", "Door state probe", "Can the door's lock / position state be read back?", "",
                     s[:300] if s else "No readable state (door/check and eventstatus/check unavailable or NG)",
                     "INFO" if s else "LIMIT", "Without a state read-back, a client cannot confirm a release worked.")

    def _watch(self, test, seconds, t0):
        last = None
        changes = []
        end = t0 + seconds
        while time.time() < end:
            s = self._state() if getattr(self, "state_ok", False) else None
            if s is not None and s != last:
                t = round(time.time() - t0, 2)
                self.rep.timeline.append([test, t, "state", s[:400]])
                changes.append(t)
                last = s
            time.sleep(self.a.poll)
        return changes

    def _ctl(self, cmd, token=None):
        return self.call("accesscontrol", "door", "control", {"Token": token or self.a.door_token, "Command": cmd})

    def h02_access(self):
        before = self._state()
        t0 = time.time()
        self.rep.timeline.append(["H02 Access", 0.0, "before", before or ""])
        r, res = self._ctl("Access")
        self.rep.timeline.append(["H02 Access", round(time.time() - t0, 2), "command", f"{res.label()} ({round(r.ms)} ms)"])
        ch = self._watch("H02 Access", self.release_s + 5, t0)
        unlock_s = round(ch[-1] - ch[0], 1) if len(ch) >= 2 else None
        m = f"{res.label()} in {round(r.ms)} ms" + (f"; state changed at {ch} s -> observed unlock about {unlock_s}s (configured {self.release_s}s)" if ch else "")
        self.rep.add("H02", "door", "Momentary release (Access)", "Command=Access releases and relocks on its own",
                     f"OK, relock after {self.release_s}s", m, "PASS" if res.ok else "FAIL", "", r.url, r.short(150), r.ms)
        if unlock_s:
            self.rep.limit("Observed release duration (s)", unlock_s, "measured", f"configured {self.release_s}")
        after = self._state()
        seen = [x[3] for x in self.rep.timeline if x[0] == "H02 Access" and x[2] == "state"]
        released = any(re.search(r"Accessed|Unlocked", s_) for s_ in seen) if before else None
        back = (after == before) if before else None
        match = (bool(released) and bool(back)) if before else None
        self.rep.push_check("H02", "door", "Access (momentary release)", before, f"Door {self.a.door_token} Command=Access",
                            res.ok, res.label(), after,
                            "state goes to Accessed / Unlocked, then returns to the 'before' state", match,
                            f"released seen: {released}; returned to before: {back}; unlock {unlock_s}s vs ReleaseTime {self.release_s}s")

    def h03_repeat(self):
        t0 = time.time()
        res_l = []
        for i in range(5):
            r, res = self._ctl("Access")
            res_l.append(res.ok)
            self.rep.timeline.append(["H03 repeat", round(time.time() - t0, 2), f"Access #{i + 1}", res.label()])
            time.sleep(1)
        ch = self._watch("H03 repeat", (time.time() - t0) + self.release_s + 3, t0)
        self.rep.add("H03", "door", "Repeated release", "5 x Access, 1 s apart, while the door is already released", "all OK",
                     f"{sum(res_l)}/5 accepted; state changes at {ch}", "PASS" if all(res_l) else "LIMIT",
                     f"Relock seen at {ch[-1]}s after the first press" + (" - each press EXTENDS the unlock." if ch and ch[-1] > self.release_s + 2 else " - presses do NOT extend the unlock." if ch else "") + " See Door timeline.")
        time.sleep(2)

    def h04_burst(self):
        n = self.a.burst
        t0 = time.time()
        oks, errs = 0, set()
        for _ in range(n):
            r, res = self._ctl("Access")
            if res.ok:
                oks += 1
            else:
                errs.add(res.label())
        el = round(time.time() - t0, 2)
        self.rep.add("H04", "door", "Burst of releases", f"{n} x Access back-to-back", "all OK",
                     f"{oks}/{n} accepted in {el}s" + (f"; {', '.join(errs)}" if errs else ""),
                     "PASS" if oks == n else "LIMIT", "Rate limit on door commands." if oks < n else "")
        time.sleep(self.release_s + 2)

    def h05_commands(self):
        cmds = [c for c in self.a.door_commands if c.lower() != "access"]
        if not cmds:
            self.rep.add("H05", "door", "Other door commands", "", "", "Only Access requested (--door-commands)", "SKIP")
            return
        enum = next((p.values for p in self.cat.params("accesscontrol", "door", "control") if p.name.lower() == "command"), [])
        caps = (self.door_info.get("Capabilities") or {})
        for i, cmd in enumerate(cmds, 1):
            before = self._state()
            t0 = time.time()
            r, res = self._ctl(cmd)
            self.rep.timeline.append([f"H05 {cmd}", 0.0, "command", res.label()])
            self._watch(f"H05 {cmd}", self.a.hold, t0)
            during = self._state()
            want = EXPECT_MODE.get(cmd)
            m1 = None if during is None or not want else (want in during)
            if not res.ok and during is not None and before is not None:
                m1 = during == before
            self.rep.push_check(f"H05.{i}", "door", f"Door command {cmd}", before, f"Command={cmd}", res.ok, res.label(),
                                during, f"DoorMode {want}" if res.ok else "unchanged", m1)
            restore = [c for c in (f"{cmd}Release",) if c in enum] + [self.a.door_restore]
            for rc in restore:
                rr, rres = self._ctl(rc)
                self.rep.timeline.append([f"H05 {cmd}", round(time.time() - t0, 2), f"restore {rc}", rres.label()])
            time.sleep(1)
            after = self._state()
            self.rep.push_check(f"H05.{i}r", "door", f"Restore after {cmd}", during, " then ".join(restore), rres.ok,
                                rres.label(), after, "same as before the command", None if before is None else after == before)
            capv = caps.get(cmd, "n/a")
            note = f"capability flag {cmd}={capv}; in enum: {'yes' if cmd in enum else 'no' if enum else '?'}; restored with {' then '.join(restore)} -> {rres.label()}"
            expect_ok = capv is True
            result = "PASS" if res.ok == expect_ok else ("FAIL" if capv in (True, False) else "INFO")
            self.rep.add(f"H05.{i}", "door", f"Door command {cmd}", "Command works when the door says it supports it",
                         "OK" if expect_ok else "NG (not supported)", res.label(), result, note, r.url, r.short(150), r.ms)
            if not rres.ok:
                self.rep.add(f"H05.{i}r", "door", f"Restore after {cmd}", "Door returned to normal", "OK", rres.label(), "FAIL",
                             f"DOOR MAY STILL BE IN {cmd} STATE - check it now.")

    def h06_unwired(self):
        un = [d for d in self.doors_data if (d.get("IOPort") or {}).get("Lock", -1) in (-1, None)]
        if not un:
            self.rep.add("H06", "door", "Command on unwired door", "", "", "Every door has a lock output", "SKIP")
            return
        tok = un[0].get("Token")
        r, res = self._ctl("Access", token=tok)
        self.rep.add("H06", "door", "Command on unwired door", f"Access on door {tok} ({un[0].get('Name')}), which has no lock output",
                     "NG", res.label(), "INFO" if not res.ok else "LIMIT",
                     "Controller accepts a release for a door with no lock wired - a client cannot tell it did nothing." if res.ok else "",
                     r.url, r.short(150), r.ms)

    def h09_event_latency(self):
        path = self.c.path("eventstatus", "eventstatus", "monitordiff", {"SchemaBased": "True"})
        es = EventStream(self.c, path).start(wait_first=6)
        if es.status != 200 or es.parts == 0:
            self.rep.add("H09", "door", "Event latency", "", "", f"monitordiff stream unavailable ({es.error or es.status})", "SKIP")
            es.stop()
            return
        time.sleep(1.0)
        tok = str(self.a.door_token)
        t_cmd = time.time()
        r, res = self._ctl("Access")
        time.sleep(self.release_s + 5)
        es.stop()
        evs = [(t, e) for t, e in es.since(t_cmd) if str((e.get("Source") or {}).get("DoorToken")) == tok]
        for t, e in evs:
            self.rep.events.append(["H09 Access", round(t - t_cmd, 3), e.get("EventName"), _cell(e.get("Source")),
                                    _cell(e.get("Data")), e.get("Time")])
        if not evs:
            self.rep.add("H09", "door", "Event latency", "Door command -> event on the monitordiff stream", "event within 2 s",
                         f"No events for door {tok} within {self.release_s + 5}s ({res.label()})", "FAIL",
                         "The Cloud Connector would not see this release.", r.url, r.short(100), r.ms)
            return
        first = round(evs[0][0] - t_cmd, 3)
        names = ", ".join(sorted({e.get("EventName", "").split(".")[-1] for _, e in evs}))
        unl = next((t for t, e in evs if re.search(r"Accessed|Unlocked", json.dumps(e.get("Data")))), None)
        rel = next((t for t, e in evs if unl and t > unl and re.search(r'"Locked"', json.dumps(e.get("Data")))), None)
        dur = round(rel - unl, 2) if unl and rel else None
        self.rep.add("H09", "door", "Event latency", "Door command -> first event on the stream the Cloud Connector reads",
                     "< 2 s", f"first event after {first}s; {len(evs)} events ({names})" + (f"; unlocked -> locked {dur}s by events" if dur else ""),
                     "PASS" if first < 2 else "LIMIT", "Full list on the Events sheet.")
        self.rep.limit("Door command -> event latency (s)", first, "measured", "monitordiff SchemaBased=True")
        if dur:
            self.rep.limit("Release duration by events (s)", dur, "measured", f"ReleaseTime {self.release_s}")

    def h07_timing(self):
        extra = [p.name for p in self.cat.params("accesscontrol", "door", "control") if p.name.lower() not in ("token", "command")]
        self.rep.add("H07", "door", "Extra timing parameter", "Does door/control accept anything besides Token and Command?",
                     "", f"Other parameters: {', '.join(extra)}" if extra else "Only Token and Command",
                     "INFO" if extra else "LIMIT",
                     "Unlock time cannot be set per request; it comes from the door's ReleaseTime." if not extra else "")

    # ======================================================================
    # CAPACITY (writes)
    # ======================================================================
    # never auto-filled: hardware, network and host-link settings
    CAPACITY_EXCLUDE = ("door", "credentialreader", "hostcommunication", "clientfilter", "capabilities")

    def load_templates(self):
        if not hasattr(self, "templates"):
            self.templates = {}
            if self.a.templates:
                with open(self.a.templates, encoding="utf-8") as f:
                    self.templates = json.load(f)
        return self.templates

    def capacity_targets(self) -> List[str]:
        templates = self.load_templates()
        if self.a.capacity_menus:
            return self.a.capacity_menus
        menus = [s for s, acts in self.cat.cgis.get("accesscontrol", {}).items()
                 if "add" in acts and "remove" in acts and "view" in acts and s not in self.CAPACITY_EXCLUDE]
        return menus + [s for s in templates if s not in menus]

    def capacity(self):
        L = "capacity"
        templates = self.load_templates()
        menus = self.capacity_targets()
        if not menus:
            self.rep.add("C00", L, "Capacity", "", "", "No accesscontrol submenu has view + add + remove", "SKIP")
            return
        progress({"t": "sequence", "menus": menus, "declared": {m: self._declared_max(m)[0] for m in menus}})
        for i, m in enumerate(menus, 1):
            try:
                self.safe(f"C{i:02d}", L, f"{m} capacity", lambda m=m, i=i: self.cap_menu(f"C{i:02d}", m, templates.get(m, {})))
            finally:
                self.cleanup_menu(m)
        self.safe("C99", L, "Controller healthy after capacity tests", lambda: self.health("C99", "capacity"))

    def cloud_state(self) -> str:
        if getattr(self, "cloud", None) is None:
            self.cloud = {}
            if not self.cat.cgis or self.cat.has("accesscontrol", "hostcommunication", "view"):
                r, res = self.c.sunapi("accesscontrol", "hostcommunication", "view")
                if res.ok and isinstance(res.data, (dict, list)):
                    self.cloud = {k: v for k, v in flatten(res.data).items() if re.search(r"cloud|connect", k, re.I)}
        return _cell(self.cloud)

    def _view_tokens(self, sub) -> Tuple[Optional[List[str]], Result]:
        r, res = self.call("accesscontrol", sub, "view")
        if not res.ok:
            return None, res
        return tokens_of(res.data), res

    def _declared_max(self, sub) -> Tuple[Optional[int], str]:
        for suffix in CAP_MAP.get(sub.lower(), []):
            for k, v in self.caps_flat.items():
                if k.lower().endswith(suffix.lower()) and _to_num(v) is not None:
                    return int(float(v)), k
        stems = {sub.lower(), sub.lower().rstrip("s"), sub.lower() + "s"}
        best = None
        for k, v in list(self.caps_flat.items()) + [(k, v) for k, v in self.cat.attributes.items()]:
            kl = re.sub(r"[^a-z]", "", k.lower())
            if "max" in kl and any(s in kl for s in stems) and _to_num(v) is not None:
                best = (int(float(v)), k)
                break
        return best if best else (None, "")

    def _builder(self, sub, tpl):
        """Return fn(n, token_style, overrides) -> (method, params, body)"""
        add_ps = self.cat.params("accesscontrol", sub, "add")

        def build(n, style, overrides=None):
            if tpl.get("add"):
                tok = f"{self.a.prefix}{n:04d}" if style == "alpha" else str(n)
                q = tpl["add"].format(n=n, token=tok, prefix=self.a.prefix, name=f"{self.a.prefix}{n:04d}")
                params = urllib.parse.parse_qsl(q, keep_blank_values=True)
                if overrides:
                    d = dict(params)
                    d.update(overrides)
                    params = list(d.items())
                return params
            params = {}
            for p in add_ps:
                if not p.req and p.name.lower() not in ("name", "token"):
                    continue
                nm = concrete(p.name)
                leaf = nm.rsplit(".", 1)[-1].lower()
                if leaf == "token":
                    params[nm] = f"{self.a.prefix}{n:04d}" if style == "alpha" else str(n)
                elif leaf == "name":
                    params[nm] = f"{self.a.prefix}{n:04d}"
                else:
                    params[nm] = fill_value(p, n, self.a.prefix)
            if overrides:
                params.update(overrides)
            return params
        return build, add_ps

    def _add(self, sub, params):
        return self.call("accesscontrol", sub, "add", params)

    def cap_menu(self, tid, sub, tpl):
        before, vres = self._view_tokens(sub)
        if before is None:
            self.rep.add(tid, "capacity", f"{sub} capacity", "", "", f"view failed: {vres.label()}", "SKIP")
            progress({"t": "step", "menu": sub, "phase": "done", "result": "SKIP", "message": f"view failed: {vres.label()}"})
            return
        self.created[sub] = set()
        self.before_tokens = getattr(self, "before_tokens", {})
        self.before_tokens[sub] = set(before)
        declared, dkey = self._declared_max(sub)
        progress({"t": "step", "menu": sub, "phase": "inspect", "existing": len(before), "declared": declared, "declaredKey": dkey})
        build, add_ps = self._builder(sub, tpl)
        # 1. first add: find a working token style
        style, first_err, n0 = None, None, 1
        numeric_start = max([int(t) for t in before if t.isdigit()] + [0]) + 1000
        for st in ("alpha", "numeric"):
            n = n0 if st == "alpha" else numeric_start
            params = build(n, st)
            r, res = self._add(sub, params)
            self.rep.capacity.append([sub, "first add", urllib.parse.urlencode(params), "yes" if res.ok else "no",
                                      "" if res.ok else res.label(), round(r.ms, 1), st])
            if res.ok:
                style = st
                self._track(sub, params, res)
                now, _ = self._view_tokens(sub)
                new = sorted(set(now or []) - set(before))
                nm = next((v for k, v in dict(params).items() if k.rsplit(".", 1)[-1].lower() == "name"), None)
                back = self._name_of(sub, new[0]) if new else None
                self.rep.push_check(f"{tid}.1", "capacity", f"{sub}: first add", f"{len(before)} objects",
                                    urllib.parse.urlencode(params), True, res.label(),
                                    f"{len(now or [])} objects; new {new[:3]}; Name read back {back!r}",
                                    f"{len(before) + 1} objects, Name {nm!r}",
                                    len(now or []) == len(before) + 1 and (nm is None or back == nm))
                for t in new:  # free the slot again (menus with MaxCount 1 would otherwise be full already)
                    self._remove(sub, t)
                    self.created[sub].discard(t)
                break
            first_err = (r, res, params)
        if not style:
            r, res, params = first_err
            req = ", ".join(f"{p.name}({p.type}{' ' + p.spec()[:30] if p.spec() else ''})" for p in add_ps if p.req) or "none declared"
            self.rep.add(tid, "capacity", f"{sub} capacity", "Add test objects until the controller refuses",
                         f"declared max {declared}" if declared else "", f"Could not build a valid add: {res.label()}", "ERROR",
                         f"Required params per spec: {req}. Copy a working add from the test client into --templates (see README).",
                         r.url, r.short(200), r.ms)
            progress({"t": "step", "menu": sub, "phase": "done", "result": "ERROR", "message": f"Could not build a valid add: {res.label()}"})
            return
        # 2. field-length / character tests on Name
        self._field_tests(sub, build, style, add_ps)
        # 3. fill to the limit
        cur, _ = self._view_tokens(sub)          # inspect: real count right before the fill
        existing = len(cur) if cur is not None else len(before) + len(self.created[sub])
        target = (declared + 1 - existing) if declared else self.a.capacity_cap
        target = max(1, min(target, self.a.capacity_cap))
        n = (n0 if style == "alpha" else numeric_start) + 100
        added, stop, t0, ms = 0, None, time.time(), []
        print(f"    {sub}: adding up to {target} objects (existing {existing}, declared max {declared})...")
        progress({"t": "step", "menu": sub, "phase": "push", "existing": existing, "declared": declared, "target": target, "pushed": 0})
        last_p = time.time()
        for i in range(target):
            params = build(n + i, style)
            r, res = self._add(sub, params)
            if res.ok:
                added += 1
                ms.append(r.ms)
                self._track(sub, params, res)
                if added % 50 == 0:
                    print(f"      {added} added")
                if time.time() - last_p > 0.5:
                    last_p = time.time()
                    progress({"t": "step", "menu": sub, "phase": "push", "existing": existing, "declared": declared, "target": target, "pushed": added})
            else:
                stop = (r, res)
                break
        el = round(time.time() - t0, 1)
        progress({"t": "step", "menu": sub, "phase": "validate", "existing": existing, "declared": declared, "target": target, "pushed": added,
                  "refused": stop[1].label() if stop else None})
        now, _ = self._view_tokens(sub)
        stored = len(now) if now is not None else None
        self.rep.push_check(f"{tid}.2", "capacity", f"{sub}: fill", f"{existing} objects", f"{added + (1 if stop else 0)} adds",
                            True, f"{added} OK" + (f", then {stop[1].label()}" if stop else ""),
                            f"{stored} objects (view)", f"{existing + added} objects",
                            None if stored is None else stored == existing + added,
                            "A mismatch means the controller answered OK to adds it did not keep, or stored one it refused.")
        if stop:
            self.rep.push_check(f"{tid}.3", "capacity", f"{sub}: add over the limit", f"{existing + added} objects",
                                "1 more add", False, stop[1].label(), f"{stored} objects",
                                f"{existing + added} objects (nothing stored)",
                                None if stored is None else stored == existing + added)
        total = stored if stored is not None else existing + added
        if stop:
            r, res = stop
            m = f"Refused at object #{total + 1} ({total} stored): {res.label()}"
            ok_vs_decl = (declared is None) or (total == declared)
            result = "LIMIT" if ok_vs_decl else "FAIL"
            note = f"declared ({dkey}) {declared}" if declared else "no declared max found"
            if declared and total != declared:
                note += f" - MISMATCH: stored {total}, declared {declared}"
            self.rep.add(tid, "capacity", f"{sub} capacity", "Add test objects until the controller refuses",
                         f"declared max {declared}" if declared else "", m, result,
                         note + f"; {added} adds in {el}s, p95 {pctl(ms, 95)} ms", r.url, r.short(150), r.ms)
            self.rep.limit(f"{sub} max objects", total, "measured", note)
            progress({"t": "step", "menu": sub, "phase": "done", "result": result, "stored": total, "expected": existing + added,
                      "declared": declared, "pushed": added, "refused": res.label(), "readbackOk": stored == existing + added if stored is not None else None,
                      "message": m})
        else:
            self.rep.add(tid, "capacity", f"{sub} capacity", "Add test objects until the controller refuses",
                         f"declared max {declared}" if declared else "",
                         f"{total} stored, no refusal (test cap {self.a.capacity_cap})",
                         "FAIL" if declared and total > declared else "INFO",
                         (f"Stored MORE than declared max {declared}." if declared and total > declared else "Raise --capacity-cap to go further.")
                         + f" {added} adds in {el}s, p95 {pctl(ms, 95)} ms")
            self.rep.limit(f"{sub} max objects", f">={total}", "measured", "cap reached")
            progress({"t": "step", "menu": sub, "phase": "done", "result": "FAIL" if declared and total > declared else "INFO", "stored": total,
                      "expected": existing + added, "declared": declared, "pushed": added, "refused": None,
                      "readbackOk": stored == existing + added if stored is not None else None, "message": f"{total} stored, no refusal (test cap)"})

    def _name_of(self, sub, token) -> Optional[str]:
        r, res = self.call("accesscontrol", sub, "view")
        for it in first_list(res.data) or []:
            if isinstance(it, dict) and str(it.get("Token")) == str(token):
                return str(it.get("Name")) if "Name" in it else None
        return None

    def _track(self, sub, params, res):
        d = dict(params)
        for k, v in d.items():
            if k.rsplit(".", 1)[-1].lower() == "token":
                self.created[sub].add(str(v))
        if isinstance(res.data, dict):
            for k, v in flatten(res.data).items():
                if k.rsplit(".", 1)[-1].lower() == "token":
                    self.created[sub].add(str(v))

    def _field_tests(self, sub, build, style, add_ps):
        name_p = next((p for p in add_ps if concrete(p.name).rsplit(".", 1)[-1].lower() == "name"), None)
        if not name_p:
            return
        nm = concrete(name_p.name)
        lens = sorted({x for x in ([name_p.maxlen, name_p.maxlen + 1] if name_p.maxlen else []) + [32, 64, 65, 128, 256] if x})
        accepted, stored_lens = [], []
        base = 50
        for i, L in enumerate(lens):
            val = ("N" * L)
            pre, _ = self._view_tokens(sub)
            r, res = self._add(sub, build(base + i, style, {nm: val}))
            post, _ = self._view_tokens(sub)
            new = sorted(set(post or []) - set(pre or []))
            back = self._name_of(sub, new[0]) if new else None
            self.rep.capacity.append([sub, "Name length", L, "yes" if res.ok else "no", "" if res.ok else res.label(), round(r.ms, 1),
                                      f"read back {len(back)} chars" if back is not None else ""])
            exp = f"Name of {L} chars stored" if res.ok else "nothing stored"
            match = (len(new) == 1 and back == val) if res.ok else (len(new) == 0)
            self.rep.push_check(f"C-{sub}-len{L}", "capacity", f"{sub}: Name length {L}", f"{len(pre or [])} objects",
                                f"Name = {L} x 'N'", res.ok, res.label(),
                                f"{len(post or [])} objects; read back {len(back) if back is not None else '-'} chars", exp, match,
                                "Stored but shortened = silent truncation." if res.ok and back is not None and back != val else "")
            if res.ok:
                accepted.append(L)
                if back is not None:
                    stored_lens.append(len(back))
            for t in new:
                self._remove(sub, t)
        mx = max(stored_lens) if stored_lens else (max(accepted) if accepted else 0)
        trunc = [L for L in accepted if stored_lens and L > mx]
        decl = name_p.maxlen
        over = [L for L in accepted if decl and L > decl]
        self.rep.add(f"C-{sub}-len", "capacity", f"{sub} Name length", f"Name lengths {lens}: push, then read back",
                     f"declared maxlen {decl}" if decl else "", f"stored up to {mx} chars; replies OK for {accepted}"
                     + (f"; SILENT TRUNCATION: {trunc} answered OK but were cut to {mx}" if trunc else ""),
                     "FAIL" if (over or trunc) else "LIMIT",
                     "Controller answers OK but keeps a shorter name - clients will show a different name than they sent." if trunc
                     else ("Accepted longer than declared." if over else ""))
        self.rep.limit(f"{sub} Name max length", mx, "measured", f"declared {decl}")
        chars = {"unicode": "Tést-Ünïcödé-中文", "symbols": "A&B=C?D#E%F+G", "quotes": "O'Brien \"Q\"", "spaces": "  lead and trail  "}
        for j, (label, val) in enumerate(chars.items()):
            params = build(base + 20 + j, style, {nm: val})
            pre, _ = self._view_tokens(sub)
            r, res = self._add(sub, params)
            back = ""
            if res.ok:
                self._track(sub, params, res)
                rr, rv = self.call("accesscontrol", sub, "view")
                lst = [it for it in (first_list(rv.data) or []) if isinstance(it, dict)]
                new = set(tokens_of(rv.data)) - set(pre or [])
                hit = next((it for it in lst if str(it.get("Token")) in new), None)
                if hit is None:
                    tok = next((v for k, v in dict(params).items() if k.rsplit(".", 1)[-1].lower() == "token"), None)
                    hit = next((it for it in lst if tok is not None and str(it.get("Token")) == str(tok)), None)
                back = str(hit.get("Name", "")) if hit else "(not found)"
            if res.ok:
                post_t, _ = self._view_tokens(sub)
                for t in set(post_t or []) - set(pre or []):
                    self._remove(sub, t)
            same = res.ok and back == val
            self.rep.push_check(f"C-{sub}-chr{j + 1}", "capacity", f"{sub}: Name {label}", "-", repr(val), res.ok, res.label(),
                                repr(back) if res.ok else "-", repr(val) if res.ok else "nothing stored",
                                same if res.ok else None)
            self.rep.capacity.append([sub, f"Name chars: {label}", val, "yes" if res.ok else "no",
                                      "" if res.ok else res.label(), round(r.ms, 1),
                                      f"read back: {back!r}" + (" (identical)" if same else " (CHANGED)" if back else "")])

    def _remove(self, sub, token):
        tpl = self.load_templates().get(sub, {}).get("remove")
        params = urllib.parse.parse_qsl(tpl.format(token=token), keep_blank_values=True) if tpl else {"Token": token}
        return self.call("accesscontrol", sub, "remove", params)

    def cleanup_menu(self, sub):
        before = getattr(self, "before_tokens", {}).get(sub)
        now, res = self._view_tokens(sub)
        targets = set(self.created.get(sub, set()))
        if now is not None and before is not None:
            targets |= set(now) - before
        if now is not None:
            targets &= set(now)
        removed, failed = 0, []
        for t in sorted(targets):
            if before is not None and t in before:
                continue
            r, rr = self._remove(sub, t)
            if rr.ok:
                removed += 1
            else:
                failed.append(f"{t}: {rr.label()}")
        left, _ = self._view_tokens(sub)
        leftover = sorted((set(left or []) - (before or set()))) if before is not None else []
        if targets:
            self.rep.push_check(f"CL-{sub}", "capacity", f"{sub}: cleanup", f"{len(now or [])} objects",
                                f"remove {len(targets)} test objects", not failed,
                                f"{removed} OK" + (f", {len(failed)} NG ({failed[0]})" if failed else ""),
                                f"{len(left or [])} objects", f"{len(before or [])} objects (original)",
                                None if left is None or before is None else set(left) == set(before))
        progress({"t": "step", "menu": sub, "phase": "cleanup", "removed": removed, "left": len(leftover)})
        if targets or leftover:
            self.rep.add(f"CL-{sub}", "capacity", f"{sub} cleanup", "Remove every test object", "0 left",
                         f"removed {removed}; left {len(leftover)}", "PASS" if not leftover else "FAIL",
                         ("Still present: " + ", ".join(leftover[:20])) if leftover else "")
        if leftover:
            print(f"  !! {len(leftover)} test objects remain in {sub}. Run with --cleanup-only.")

    def cleanup_only(self):
        subs = [s for s, acts in self.cat.cgis.get("accesscontrol", {}).items() if "remove" in acts and "view" in acts]
        pre = self.a.prefix
        for sub in subs:
            r, res = self.call("accesscontrol", sub, "view")
            lst = first_list(res.data) or []
            hits = []
            for it in lst:
                if isinstance(it, dict) and (str(it.get("Token", "")).startswith(pre) or str(it.get("Name", "")).startswith(pre)
                                             or re.fullmatch(r"N{32,}", str(it.get("Name", "")))):
                    hits.append(str(it.get("Token")))
            ok = 0
            for t in hits:
                _, rr = self._remove(sub, t)
                ok += rr.ok
            self.rep.add(f"CL-{sub}", "capacity", f"{sub} cleanup-only", f"Remove objects whose Token/Name starts with {pre}",
                         "", f"found {len(hits)}, removed {ok}", "PASS" if ok == len(hits) else "FAIL")

    # ======================================================================
    # LOCKOUT
    # ======================================================================
    def lockout(self):
        self.safe("K01", "lockout", "Login lockout", self.k01)

    def k01(self):
        user = self.a.lockout_user or self.c.user
        path = self.c.path("system", "deviceinfo", "view")
        good_user = user == self.c.user
        if not good_user and not self.a.lockout_password:
            self.rep.add("K01", "lockout", "Login lockout", "", "", "--lockout-user needs --lockout-password", "SKIP")
            return
        good_pw = self.c.password if good_user else self.a.lockout_password

        def good():
            r = self.c.request("GET", path, user=user, password=good_pw)
            return r.status == 200 and parse_sunapi(r).ok, r

        def bad():
            return self.c.request("GET", path, user=user, password="ZZT-wrong-" + os.urandom(3).hex())

        ok, r = good()
        if not ok:
            self.rep.add("K01", "lockout", "Login lockout", "", "", f"Good login fails before test: {r.short(100)}", "ERROR")
            return
        total_bad = 0
        locked_at = None
        bad_sample = None
        for k in range(1, self.a.lockout_attempts + 1):
            for _ in range(k):
                bad_sample = bad()
                total_bad += 1
            ok, r = good()
            if not ok:
                locked_at = (k, r)
                break
        if not locked_at:
            self.rep.add("K01", "lockout", "Login lockout", "Wrong passwords until the correct one is refused",
                         "", f"No lockout seen (up to {self.a.lockout_attempts} consecutive, {total_bad} wrong in total)",
                         "LIMIT", "No brute-force protection observed within the test range - security finding.")
            self.rep.limit("Login lockout threshold", f">{self.a.lockout_attempts}", "measured", "")
            return
        k, lr = locked_at
        self.rep.push_check("K01.1", "lockout", "Wrong passwords -> lockout", "correct login works",
                            f"{k} consecutive wrong passwords ({total_bad} total)", True, "401 each time",
                            f"correct login refused: {lr.short(80)}", "correct login refused (locked)", True)
        t_lock = time.time()
        sig = f"HTTP {lr.status}" + (f" {lr.text.strip()[:80]}" if lr.text.strip() else "")
        self.rep.limit("Login lockout threshold (consecutive wrong)", k, "measured", f"{total_bad} wrong in total; locked response {sig}")
        print(f"    locked out after {k} consecutive wrong passwords - measuring how long (up to {self.a.lockout_wait}s)...")
        unlocked = None
        while time.time() - t_lock < self.a.lockout_wait:
            time.sleep(self.a.lockout_poll)
            ok, _ = good()
            if ok:
                unlocked = round(time.time() - t_lock)
                break
        self.rep.push_check("K01.2", "lockout", "Lockout clears by itself", "correct login refused",
                            f"wait (poll every {self.a.lockout_poll}s)", True, "-",
                            "correct login works" if unlocked else f"still refused after {self.a.lockout_wait}s",
                            "correct login works again", bool(unlocked), f"unlocked after {unlocked}s" if unlocked else "")
        m = f"Locked after {k} consecutive wrong passwords ({total_bad} total); locked answer: {sig}; " + \
            (f"unlocked after about {unlocked}s" if unlocked else f"STILL LOCKED after {self.a.lockout_wait}s")
        self.rep.add("K01", "lockout", "Login lockout", "Wrong passwords until the correct one is refused, then time to unlock",
                     "", m, "LIMIT", f"Polled the good password every {self.a.lockout_poll}s; polling during a lockout may extend it on some firmware. Wrong-password answer: {bad_sample.short(80) if bad_sample else ''}")
        self.rep.limit("Login lockout duration (s)", unlocked if unlocked else f">{self.a.lockout_wait}", "measured",
                       f"poll every {self.a.lockout_poll}s")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Probe a Hanwha NHP access controller over SUNAPI and report its limits.",
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--host", required=False)
    ap.add_argument("--json-out", help="also write the report as JSON (used by Aether)")
    ap.add_argument("--xlsx-to-json", nargs=2, metavar=("XLSX", "JSON"), help="convert a report .xlsx to JSON and exit")
    ap.add_argument("--json-to-xlsx", nargs=2, metavar=("JSON", "XLSX"), help='write {"sheets":{name:rows}} as .xlsx and exit')
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", help="or set NHP_PASSWORD; prompted if missing")
    ap.add_argument("--scheme", choices=["https", "http"], default="https")
    ap.add_argument("--port", type=int, help="default 443 for https, 80 for http")
    ap.add_argument("--http-port", type=int, default=80, help="port for the plain-HTTP test (P01)")
    ap.add_argument("--root", default="stw-cgi")
    ap.add_argument("--levels", default=",".join(SAFE_LEVELS), help="comma list or 'all'")
    ap.add_argument("--out", help="report path (.xlsx)")
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("--text", action="store_true", help="do not ask for JSON responses")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompts for door/capacity/lockout")
    ap.add_argument("--sweep-all", action="store_true", help="include log/stream/heavy menus in the view sweep")
    # protocol / load
    ap.add_argument("--nonce-max", type=int, default=300)
    ap.add_argument("--url-sizes", default="1024,2048,4096,8192,16384,32768,65536")
    ap.add_argument("--seq-count", type=int, default=50)
    ap.add_argument("--concurrency-max", type=int, default=32)
    ap.add_argument("--monitor-max", type=int, default=10)
    ap.add_argument("--stream-secs", type=float, default=15.0, help="how long N08 keeps the monitordiff stream open")
    # door
    ap.add_argument("--door-token", help="door to release in the door tests (e.g. 1)")
    ap.add_argument("--door-commands", default="Access", help="comma list, e.g. Access,Unlock,LockDown")
    ap.add_argument("--door-restore", default="Lock", help="command that returns the door to normal after each test command")
    ap.add_argument("--hold", type=float, default=4.0, help="seconds to watch after each non-Access command")
    ap.add_argument("--burst", type=int, default=10)
    ap.add_argument("--poll", type=float, default=0.25, help="door state poll interval (s)")
    # capacity
    ap.add_argument("--capacity-menus", help="comma list of accesscontrol submenus (default: every one with view+add+remove)")
    ap.add_argument("--capacity-cap", type=int, default=1000, help="max objects to add per submenu")
    ap.add_argument("--templates", help="JSON file with add templates per submenu (see README)")
    ap.add_argument("--prefix", default="ZZT", help="prefix for test object tokens/names")
    ap.add_argument("--cleanup-only", action="store_true", help="only remove leftover test objects, then exit")
    # lockout
    ap.add_argument("--lockout-user", help="user for the lockout test (default --user; a spare test user is safer)")
    ap.add_argument("--lockout-password")
    ap.add_argument("--lockout-attempts", type=int, default=10)
    ap.add_argument("--lockout-wait", type=int, default=900)
    ap.add_argument("--lockout-poll", type=int, default=15)
    a = ap.parse_args(argv)
    a.port = a.port or (443 if a.scheme == "https" else 80)
    a.levels = ALL_LEVELS if a.levels.strip().lower() == "all" else [x.strip().lower() for x in a.levels.split(",") if x.strip()]
    bad = [x for x in a.levels if x not in ALL_LEVELS]
    if bad:
        ap.error(f"unknown level(s): {bad}")
    a.url_sizes = [int(x) for x in a.url_sizes.split(",")]
    a.door_commands = [x.strip() for x in a.door_commands.split(",") if x.strip()]
    a.capacity_menus = [x.strip() for x in a.capacity_menus.split(",")] if a.capacity_menus else None
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
    a.out = a.out or f"nhp-limits-{(a.host or 'report').replace(':', '_')}-{stamp}.xlsx"
    return a


def confirm(a, levels, suite=None) -> List[str]:
    risky = {
        "door": f"RELEASES door {a.door_token} for real (commands: {', '.join(a.door_commands)}; restore with {a.door_restore}).",
        "capacity": f"ADDS test objects (prefix {a.prefix}) to the controller until it refuses, then removes them. "
                    f"Menus: {', '.join(suite.capacity_targets()) if suite else '?'}.",
        "lockout": f"Sends wrong passwords for user '{a.lockout_user or a.user}' until the controller LOCKS that login "
                   f"(can take up to {a.lockout_wait}s to unlock). Use a spare test user if you can.",
    }
    cloud = suite.cloud_state() if suite else ""
    if cloud and re.search(r"connected", cloud, re.I) and not re.search(r"disconnected", cloud, re.I):
        for lv in ("capacity", "door"):
            risky[lv] += (f"\n  WARNING: a Cloud Connector looks connected ({cloud[:120]}). The cloud sync can delete or "
                          "overwrite test objects and will publish door events to the cloud. Prefer an unclaimed controller.")
    keep = []
    for lv in levels:
        if lv not in risky:
            keep.append(lv)
            continue
        if lv == "door" and not a.door_token:
            print("  door level needs --door-token; skipping it.")
            continue
        if a.yes:
            keep.append(lv)
            continue
        print(f"\n  '{lv}' {risky[lv]}")
        ans = input("  Type YES to run it, anything else to skip: ").strip()
        if ans == "YES":
            keep.append(lv)
    return keep


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass
    a = parse_args(argv)
    if a.json_to_xlsx:
        with open(a.json_to_xlsx[0], encoding="utf-8") as f:
            d = json.load(f)
        write_xlsx_stdlib(a.json_to_xlsx[1], list(d["sheets"].items()))
        return 0
    if a.xlsx_to_json:
        with open(a.xlsx_to_json[1], "w", encoding="utf-8") as f:
            json.dump(xlsx_to_json(a.xlsx_to_json[0]), f, ensure_ascii=False)
        return 0
    if not a.host:
        print("--host is required"); return 2
    global JSON_OUT
    JSON_OUT = a.json_out
    a.lockout_password = a.lockout_password or os.environ.get("NHP_LOCKOUT_PASSWORD")
    pw = a.password or os.environ.get("NHP_PASSWORD") or getpass.getpass(f"Password for {a.user}@{a.host}: ")
    rep = Report()
    logf = open(os.path.splitext(a.out)[0] + ".log.jsonl", "w", encoding="utf-8")
    log_lock = threading.Lock()

    def log(r: Resp, h):
        with log_lock:
            logf.write(json.dumps({"t": dt.datetime.now().isoformat(timespec="milliseconds"), "method": r.method,
                                   "url": r.url, "status": r.status, "ms": round(r.ms, 1), "error": r.error,
                                   "bytes": len(r.body), "body": r.text[:500]}) + "\n")

    c = Client(a.host, a.port, a.scheme, a.user, pw, a.root, a.timeout, not a.text, log)
    s = Suite(a, c, rep)
    started = dt.datetime.now()
    print(f"nhp_limits {VERSION} -> {a.scheme}://{a.host}:{a.port}")
    levels = a.levels
    try:
        print("\n== discovery ==")
        progress({"t": "level", "level": "discovery"})
        s.d01_deviceinfo()
        s.safe("D02", "discovery", "attributes.cgi (API spec)", s.d02_attributes)
        if a.cleanup_only:
            s.cleanup_only()
            levels = []
        else:
            if "discovery" in levels:
                for tid, name, fn in [("D03", "Declared limits", s.d03_attr_limits), ("D04", "Capabilities", s.d04_capabilities),
                                      ("D05", "Doors", s.d05_doors), ("D06", "Missing ACS functions", s.d06_missing),
                                      ("D07", "Declared field limits", s.d07_field_limits), ("D08", "View sweep", s.d08_view_sweep)]:
                    s.safe(tid, "discovery", name, fn)
            else:
                s.safe("D04", "discovery", "Capabilities", s.d04_capabilities)
                s.safe("D05", "discovery", "Doors", s.d05_doors)
            levels = confirm(a, [lv for lv in levels if lv != "discovery"], s)
            for lv in levels:
                print(f"\n== {lv} ==")
                progress({"t": "level", "level": lv})
                getattr(s, lv)()
    except KeyboardInterrupt:
        print("\nInterrupted - cleaning up and writing what we have.")
        rep.add("X01", "run", "Interrupted", "", "", "Ctrl+C", "ERROR")
        for sub in list(s.created):
            try:
                s.cleanup_menu(sub)
            except Exception:
                pass
    except SystemExit as e:
        print(str(e))
    finally:
        logf.close()
    meta = {
        "Controller": f"{a.scheme}://{a.host}:{a.port}",
        "Model": s.devinfo.get("Model", ""),
        "Firmware": s.devinfo.get("FirmwareVersion", s.devinfo.get("FirmwareVer", "")),
        "Device type": s.devinfo.get("DeviceType", ""),
        "User": a.user,
        "Levels run": ", ".join(["discovery"] + [lv for lv in levels if lv != "discovery"]) if not a.cleanup_only else "cleanup-only",
        "Started": started.strftime("%Y-%m-%d %H:%M:%S"),
        "Duration (s)": str(round((dt.datetime.now() - started).total_seconds())),
        "Requests sent": str(c.count),
        "Tool": f"nhp_limits.py {VERSION}",
        "Legend": "PASS = behaved correctly; LIMIT = a limit or restriction found; FAIL = wrong / broken; INFO = observation; SKIP; ERROR = test could not run",
    }
    path = write_report(rep, a.out, meta)
    cn = rep.counts()
    print(f"\nReport: {path}")
    progress({"t": "done", "report": path, "counts": rep.counts()})
    print("  " + "  ".join(f"{k} {v}" for k, v in cn.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
