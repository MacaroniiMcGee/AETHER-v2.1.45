# AETHER_TRAFFIC — mitmproxy addon used by the Traffic Inspector (Tools › Traffic Inspector).
#
# mitmdump loads this with -s. Everything it sees goes to the Aether backend as JSON lines
# over a Unix socket (path in AETHER_TRAFFIC_SOCK):
#   HTTP        once when the request is complete, again with the response / error
#   WebSocket   each message, added to the HTTP flow that opened it
#   TCP / UDP   start, each message (direction + bytes), end
#   DNS         query and answer (gateway mode: the device's DNS is sent to mitmproxy)
#   TLS         in gateway mode HTTPS is passed through untouched unless decrypting is on;
#               one "tls" line records where it went (server name from the TLS hello)
# Device ports (reverse mode): redirects that point at the device's own address are
# rewritten to the Pi's address so a browser stays inside the capture.
#
# Standard library + mitmproxy only. Works with mitmproxy 11 and 12.
import base64
import json
import os
import queue
import socket
import threading
import time
import uuid
from urllib.parse import urlsplit, urlunsplit

SOCK = os.environ.get("AETHER_TRAFFIC_SOCK", "")
BODY_MAX = int(os.environ.get("AETHER_TRAFFIC_BODY_MAX", str(1024 * 1024)))
MSG_MAX = int(os.environ.get("AETHER_TRAFFIC_MSG_MAX", str(64 * 1024)))
GW_DECRYPT = os.environ.get("AETHER_TRAFFIC_GW_DECRYPT", "0") == "1"


class _Feed:
    """Sends lines to the backend from a thread so the proxy never waits on Aether."""

    def __init__(self, path):
        self.path = path
        self.q = queue.Queue(maxsize=20000)
        self.sock = None
        threading.Thread(target=self._run, name="aether-feed", daemon=True).start()

    def put(self, obj):
        try:
            self.q.put_nowait((json.dumps(obj, separators=(",", ":"), default=str) + "\n").encode())
        except queue.Full:
            pass  # backend is not reading; drop rather than slow the proxy

    def _run(self):
        pending = None
        while True:
            line = pending or self.q.get()
            pending = None
            try:
                if self.sock is None:
                    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    s.connect(self.path)
                    self.sock = s
                self.sock.sendall(line)
            except OSError:
                try:
                    if self.sock:
                        self.sock.close()
                except OSError:
                    pass
                self.sock = None
                pending = line
                time.sleep(0.5)


def _bytes(raw, limit):
    """(text-or-base64, encoding, full size, truncated)"""
    if raw is None:
        return None, "utf8", 0, False
    size = len(raw)
    cut = raw[:limit]
    try:
        return cut.decode("utf-8"), "utf8", size, size > limit
    except UnicodeDecodeError:
        return base64.b64encode(cut).decode("ascii"), "base64", size, size > limit


def _body(msg):
    if msg is None:
        return None, "utf8", 0, False
    try:
        raw = msg.get_content(strict=False)  # undoes gzip/deflate/br when it can
    except Exception:
        raw = msg.raw_content
    return _bytes(raw, BODY_MAX)


def _headers(h):
    return [[k, v] for k, v in h.items(multi=True)]


def _mode(flow_or_conn):
    conn = getattr(flow_or_conn, "client_conn", flow_or_conn)
    try:
        return conn.proxy_mode.full_spec
    except Exception:
        return ""


def _peer(conn):
    a = getattr(conn, "peername", None) or ("", 0)
    return a[0]


def _addr(conn):
    a = getattr(conn, "address", None) or ("", 0)
    return [str(a[0]), int(a[1] or 0)]


def _msg(m):
    text, enc, size, cut = _bytes(m.content, MSG_MAX)
    return {"fromClient": bool(m.from_client), "ts": m.timestamp, "data": text, "encoding": enc, "bytes": size, "truncated": cut}


class AetherFeed:
    def __init__(self):
        self.feed = _Feed(SOCK) if SOCK else None

    def _put(self, rec):
        if self.feed:
            self.feed.put(rec)

    # ── HTTP ────────────────────────────────────────────────────────────
    def _send(self, flow, phase):
        rq = flow.request
        body, enc, size, cut = _body(rq)
        rec = {
            "kind": "http", "phase": phase, "id": flow.id, "ts": rq.timestamp_start,
            "client": _peer(flow.client_conn), "mode": _mode(flow),
            "clientTls": bool(getattr(flow.client_conn, "tls_established", False)),
            "request": {
                "method": rq.method, "scheme": rq.scheme,
                "host": rq.pretty_host if hasattr(rq, "pretty_host") else rq.host,
                "port": rq.port, "path": rq.path, "httpVersion": rq.http_version,
                "headers": _headers(rq.headers),
                "body": body, "bodyEncoding": enc, "bytes": size, "truncated": cut,
                "tsEnd": rq.timestamp_end,
            },
        }
        rs = flow.response
        if rs is not None:
            body, enc, size, cut = _body(rs)
            rec["response"] = {
                "status": rs.status_code, "reason": rs.reason, "httpVersion": rs.http_version,
                "headers": _headers(rs.headers),
                "body": body, "bodyEncoding": enc, "bytes": size, "truncated": cut,
                "tsStart": rs.timestamp_start, "tsEnd": rs.timestamp_end,
            }
            moved = flow.metadata.get("aether_location")
            if moved:
                rec["response"]["locationWas"] = moved
        if flow.error is not None:
            rec["error"] = str(flow.error.msg)
        self._put(rec)

    def request(self, flow):
        self._send(flow, "request")

    def response(self, flow):
        self._rewrite_location(flow)
        self._send(flow, "response")

    def error(self, flow):
        self._send(flow, "error")

    def _rewrite_location(self, flow):
        """Device ports: a redirect to the device's own address would leave the capture."""
        if not _mode(flow).startswith("reverse:") or flow.response is None:
            return
        loc = flow.response.headers.get("location")
        if not loc:
            return
        try:
            u = urlsplit(loc)
            dev = flow.server_conn.address[0] if flow.server_conn.address else flow.request.host
            if not u.hostname or u.hostname not in (dev, flow.request.host):
                return
            here = flow.client_conn.sockname
            host = here[0] if ":" not in here[0] else f"[{here[0]}]"
            scheme = "https" if getattr(flow.client_conn, "tls_established", False) else "http"
            flow.response.headers["location"] = urlunsplit((scheme, f"{host}:{here[1]}", u.path, u.query, u.fragment))
            flow.metadata["aether_location"] = loc
        except Exception:
            pass

    # ── WebSocket (messages belong to the HTTP flow that upgraded) ──────
    def websocket_message(self, flow):
        m = flow.websocket.messages[-1]
        text, enc, size, cut = _bytes(m.content if isinstance(m.content, bytes) else str(m.content).encode(), MSG_MAX)
        self._put({"kind": "ws", "phase": "msg", "id": flow.id, "msg": {
            "fromClient": bool(m.from_client), "ts": m.timestamp, "data": text, "encoding": enc,
            "bytes": size, "truncated": cut, "text": bool(getattr(m, "is_text", False))}})

    def websocket_end(self, flow):
        ws = flow.websocket
        self._put({"kind": "ws", "phase": "end", "id": flow.id, "closeCode": getattr(ws, "close_code", None)})

    # ── raw TCP / UDP ───────────────────────────────────────────────────
    def _stream(self, kind, flow, phase, extra=None):
        rec = {"kind": kind, "phase": phase, "id": flow.id}
        if phase == "start":
            rec.update({"ts": getattr(flow.client_conn, "timestamp_start", None) or time.time(),
                        "client": _peer(flow.client_conn), "server": _addr(flow.server_conn), "mode": _mode(flow),
                        "sni": getattr(flow.client_conn, "sni", None)})
        if extra:
            rec.update(extra)
        self._put(rec)

    def tcp_start(self, flow):
        self._stream("tcp", flow, "start")

    def tcp_message(self, flow):
        self._stream("tcp", flow, "msg", {"msg": _msg(flow.messages[-1])})

    def tcp_end(self, flow):
        self._stream("tcp", flow, "end")

    def tcp_error(self, flow):
        self._stream("tcp", flow, "end", {"error": str(flow.error.msg) if flow.error else "error"})

    def udp_start(self, flow):
        self._stream("udp", flow, "start")

    def udp_message(self, flow):
        self._stream("udp", flow, "msg", {"msg": _msg(flow.messages[-1])})

    def udp_end(self, flow):
        self._stream("udp", flow, "end")

    def udp_error(self, flow):
        self._stream("udp", flow, "end", {"error": str(flow.error.msg) if flow.error else "error"})

    # ── DNS ─────────────────────────────────────────────────────────────
    def _dns(self, flow, phase):
        def js(m):
            try:
                return m.to_json()
            except Exception:
                return None
        rec = {"kind": "dns", "phase": phase, "id": flow.id, "ts": flow.request.timestamp if flow.request else time.time(),
               "client": _peer(flow.client_conn), "mode": _mode(flow), "request": js(flow.request),
               "response": js(flow.response) if flow.response else None}
        if flow.error is not None:
            rec["error"] = str(flow.error.msg)
        self._put(rec)

    def dns_request(self, flow):
        self._dns(flow, "request")

    def dns_response(self, flow):
        self._dns(flow, "response")

    def dns_error(self, flow):
        self._dns(flow, "error")

    # ── TLS in gateway mode ─────────────────────────────────────────────
    def tls_clienthello(self, data):
        conn = data.context.client
        if not _mode(conn).startswith("transparent") or GW_DECRYPT:
            return
        data.ignore_connection = True  # pass through untouched: the device keeps working
        srv = data.context.server
        self._put({"kind": "tls", "phase": "start", "id": str(uuid.uuid4()), "ts": time.time(),
                   "client": _peer(conn), "server": _addr(srv), "mode": _mode(conn),
                   "sni": data.client_hello.sni, "alpn": [a.decode("ascii", "replace") for a in (data.client_hello.alpn_protocols or [])]})

    def tls_failed_client(self, data):
        conn = data.context.client
        if _mode(conn).startswith("transparent"):
            self._put({"kind": "tls", "phase": "failed", "id": str(uuid.uuid4()), "ts": time.time(),
                       "client": _peer(conn), "server": _addr(data.context.server), "mode": _mode(conn),
                       "sni": getattr(conn, "sni", None), "error": str(getattr(conn, "error", "") or "the device refused the Pi's certificate")})


addons = [AetherFeed()]
