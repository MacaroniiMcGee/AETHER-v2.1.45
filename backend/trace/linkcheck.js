// AETHER_TRACE (TRACE-8) — can this Pi reach each controller on the local network?
// A short TCP connect to the controller's web port (what SUNAPI uses; ICMP ping would need root). "Refused" still means the
// host answered, so it counts as reachable. Controllers: the access controllers saved in Tools › SUNAPI Console, plus the
// controller IP addresses in Setup › Wire. Nothing is sent beyond the TCP handshake, and no login is used.
// Emulated Azure boards (Controller Emulator): the link there is RS-485. A board counts as reachable while the Azure controller
// (BLU-IC2) keeps polling it; nothing is sent to check it.
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

const SUNAPI = path.join(__dirname, '..', 'data', 'sunapi');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const isAccess = d => d && (d.kind === 'access' || /^NHP|^NOP|ACS/i.test(String(d.model || '')));

/** TCP connect to host:port. → { ok, ms, refused?, error? } */
function probe(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let done = false;
    const s = net.connect({ host: String(host).replace(/^\[|\]$/g, ''), port: Number(port) });
    const end = r => { if (done) return; done = true; try { s.destroy(); } catch { /* */ } resolve({ ...r, ms: Date.now() - t0 }); };
    s.setTimeout(timeoutMs, () => end({ ok: false, error: 'no answer' }));
    s.once('connect', () => end({ ok: true }));
    s.once('error', e => end(e && e.code === 'ECONNREFUSED' ? { ok: true, refused: true } : { ok: false, error: e && e.code === 'EHOSTUNREACH' ? 'host unreachable' : e && e.code === 'ENETUNREACH' ? 'network unreachable' : e && (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') ? 'name not found' : e && e.code === 'ETIMEDOUT' ? 'no answer' : (e && (e.code || e.message)) || 'error' }));
  });
}

/** The controllers to check: SUNAPI Console access controllers (with their port) and the Wire lane IPs not already among them. */
function targets(wireIps = []) {
  const creds = readJson(path.join(SUNAPI, 'sunapi-credentials.json'), {});
  const list = readJson(path.join(SUNAPI, 'devices.json'), []).filter(isAccess).slice(0, 32)
    .map(d => ({ id: d.id, name: d.name || d.host, host: d.host, ports: [d.port || (d.https ? 443 : 80)], model: d.model || null, source: 'sunapi', login: !!creds[d.id] }));
  const known = new Set(list.map(x => String(x.host).replace(/^\[|\]$/g, '')));
  for (const ip of wireIps || []) if (ip && !known.has(ip)) { known.add(ip); list.push({ id: `ip:${ip}`, name: ip, host: ip, ports: [443, 80], model: null, source: 'wire', login: false }); }
  return list;
}

const POLL_FRESH_MS = 5000;   // an IC2 polls each board many times a second; 5 s of silence means it is not talking to it
/** The Controller Emulator's boards as links: up while the Azure controller polls them. */
function emulatedLinks(st, now = Date.now()) {
  if (!st) return [];
  return (st.devices || []).map(d => {
    const age = d.lastPollAt ? now - d.lastPollAt : null;
    const up = !!st.running && age != null && age <= POLL_FRESH_MS;
    return { id: `emu:${d.address}`, name: `Board #${d.address} ${d.model || ''}`.trim(), host: st.port || 'RS-485', port: null, model: d.model || null, source: 'emulated', login: null,
      link: up ? 'up' : 'down', ms: null, polls: d.pollCount || 0, lastPollAt: d.lastPollAt || null,
      note: !st.running ? 'Controller Emulator is stopped' : age == null ? 'the Azure controller has never polled this board (check RS-485 wiring, baud and its address in the controller)' : up ? null : `the Azure controller stopped polling it ${Math.round(age / 1000)} s ago` };
  });
}

/** Check them all at once. → { at, controllers: [{ id, name, host, port, model, source: 'sunapi'|'wire'|'emulated', login, link: 'up'|'down', ms, note }] } */
async function checkLinks(opt = {}) {
  const list = targets(opt.wireIps);
  const out = await Promise.all(list.map(async c => {
    let r = null, port = c.ports[0];
    for (const p of c.ports) { r = await probe(c.host, p, opt.timeoutMs || 1500); port = p; if (r.ok) break; }
    return { id: c.id, name: c.name, host: c.host, port, model: c.model, source: c.source, login: c.login, link: r.ok ? 'up' : 'down', ms: r.ms,
      note: r.ok ? (r.refused ? `answered, but port ${port} is closed` : null) : `${r.error}: not reachable from this Pi (cloud only?)` };
  }));
  let emu = [];
  try { emu = opt.emulator && typeof opt.emulator.status === 'function' ? emulatedLinks(opt.emulator.status()) : []; } catch { emu = []; }
  return { at: Date.now(), controllers: out.concat(emu) };
}

/** What changed between two checks: [{ id, name, host, from, to }] */
function linkChanges(prev, next) {
  if (!prev || !next) return [];
  const before = new Map((prev.controllers || []).map(c => [c.id, c.link]));
  return (next.controllers || []).filter(c => before.has(c.id) && before.get(c.id) !== c.link)
    .map(c => ({ id: c.id, name: c.name, host: c.host, from: before.get(c.id), to: c.link, at: next.at }));
}

module.exports = { probe, targets, checkLinks, linkChanges, emulatedLinks, POLL_FRESH_MS };
