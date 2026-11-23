// trace/cloud.js — OnCAFE as Event Trace sees it, live.   AETHER_TRACE
//
// Uses the Pi's existing OnCAFE sign-in (routes-oncafe.js, Update 58). Two feeds:
//   push  The same MQTT-over-WebSocket feed the OnCAFE web app uses. GET {partner}/platform/v2 returns
//         data.acsmqtt { wsHost, username (= accountId), token (60 h JWT) }; we connect to
//         wss://<wsHost>/mqtt and subscribe d/rt-events/<controller> (access and door events),
//         d/settings/<controller> (I/O), b/notify/<org> (door state). Arrival time on the Pi clock is
//         the "cloud push" hop.
//   api   Polls /acstimeline/orgs/<org>/door/events for the doors under test; the first time an event
//         is listed is the "visible in the event log" hop. Optional, every pollMs.
// Tokens stay in memory; nothing here is written to disk except through the run's Vault.
'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { Mqtt5 } = require('./mqtt5');
const { fromCloud } = require('./normalize');

let oncafe = null;
function lib() {
  if (!oncafe) oncafe = require('../routes-oncafe');
  if (typeof oncafe.api !== 'function') throw Object.assign(new Error('This Aether is missing the OnCAFE session helpers (routes-oncafe.js). Re-run the Event Trace installer.'), { status: 500 });
  return oncafe;
}

const isCamera = d => /ipcam|camera|nvr|phone|iphone|google|phxsystem|^vms/i.test(String(d.deviceType || '')) || /^X|^P[NQ]|^Q|^XN/i.test(String(d.model || ''));

class CloudFeed extends EventEmitter {
  constructor(log = () => {}) {
    super();
    this.log = log;
    this.cfg = null;           // { url, org, controllers[], doors[], poll, pollMs }
    this.H = null;
    this.mqtt = null;
    this.mq = { state: 'off', error: null, topics: [], acked: [], host: null, connectedAt: null, received: 0, lastAt: null, tokenExpiry: null };
    this.poll = { state: 'off', error: null, lastAt: null, seen: 0, ms: null };
    this._pollTimer = null;
    this._retry = null;
    this._retries = 0;
    this._renew = null;
    this._seen = new Map();    // api event key -> first seen (bounded)
    this.stopped = true;
  }

  status() {
    return {
      configured: !!this.cfg, url: this.cfg ? this.cfg.url : null, org: this.cfg ? this.cfg.org : null,
      controllers: this.cfg ? this.cfg.controllers : [], doors: this.cfg ? this.cfg.doors : [],
      push: { ...this.mq }, api: { ...this.poll, enabled: !!(this.cfg && this.cfg.poll) },
    };
  }

  /** Doors and controllers of the signed-in org, for the Setup page. */
  async inventory(url, org) {
    const o = lib();
    const H = o.hosts(url);
    if (!H) throw Object.assign(new Error('Enter an OnCAFE address ending in oncafe.hanwhavision.cloud.'), { status: 400 });
    const list = (d, keys) => Array.isArray(d) ? d : (keys.map(k => d && d[k]).find(Array.isArray) || []);
    const [devs, doors] = await Promise.all([
      o.api(H, `${H.device}/${org}/devices`).then(d => list(d, ['devices'])),
      o.api(H, `${H.io}/${org}/doors/v2?pageNumber=0&pageSize=1000`).then(d => list(d, ['doors'])).catch(() => []),
    ]);
    const controllers = devs.filter(d => !isCamera(d) && (!d.parentId || /acc|panel|controller/i.test(String(d.deviceType || ''))))
      .map(d => ({ id: d.deviceId, name: d.deviceName || d.deviceId, model: d.modelNumber || d.model || d.deviceType || '', status: d.connectionStatus || d.deviceStatus || '', type: d.deviceType || '' }));
    return {
      controllers,
      doors: doors.map(x => ({ id: x.doorId || x.id, name: x.doorName || x.name || '', controllerId: x.controllerId || x.deviceId || '' })),
    };
  }

  async start(cfg) {
    await this.stop();
    const o = lib();
    const H = o.hosts(cfg.url);
    if (!H) throw Object.assign(new Error('Enter an OnCAFE address ending in oncafe.hanwhavision.cloud.'), { status: 400 });
    if (!/^[0-9a-f-]{36}$/i.test(String(cfg.org || ''))) throw Object.assign(new Error('Pick the OnCAFE organisation first.'), { status: 400 });
    const st = o.status(H);
    if (!st.signedIn) throw Object.assign(new Error('Sign in to OnCAFE first (Setup › OnCAFE).'), { status: 401 });
    this.H = H;
    this.cfg = { url: cfg.url, org: cfg.org, controllers: (cfg.controllers || []).filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 64), doors: (cfg.doors || []).filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 50), poll: cfg.poll !== false, pollMs: Math.max(1000, Math.min(30000, Number(cfg.pollMs) || 2000)) };
    this.stopped = false;
    this._retries = 0;
    await this._connect().catch(e => { this.mq.error = e.message; this._scheduleRetry(); });
    if (this.cfg.poll && this.cfg.doors.length) this._startPoll();
    return this.status();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this._retry); this._retry = null;
    clearTimeout(this._renew); this._renew = null;
    clearInterval(this._pollTimer); this._pollTimer = null;
    if (this.mqtt) { const m = this.mqtt; this.mqtt = null; m.removeAllListeners(); m.on('error', () => {}); m.close(); }
    this.mq = { ...this.mq, state: 'off', connectedAt: null };
    this.poll = { ...this.poll, state: 'off' };
  }

  _scheduleRetry() {
    if (this.stopped) return;
    const wait = [2000, 5000, 10000, 30000, 60000][Math.min(this._retries++, 4)];
    this.mq.state = 'retrying';
    this.mq.retryAt = Date.now() + wait;
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this._connect().catch(e => { this.mq.error = e.message; this._scheduleRetry(); }), wait);
    if (this._retry.unref) this._retry.unref();
  }

  async _connect() {
    const o = lib();
    const H = this.H;
    this.mq.state = 'connecting'; this.mq.error = null;
    const plat = await o.api(H, `${H.partner}/platform/v2`);
    const m = (plat && (plat.acsmqtt || plat.mqtt)) || null;
    if (!m || !m.token || !m.username) throw new Error('OnCAFE did not return a messaging token (platform/v2 has no acsmqtt).');
    const host = m.wsHost || m.host;
    const port = Number(m.wsPort || 443);
    const scheme = process.env.AETHER_TRACE_WS_INSECURE === '1' ? 'ws' : 'wss';   // tests only
    const url = `${scheme}://${host}${port === 443 ? '' : ':' + port}/mqtt`;
    const accountId = String(m.username);
    const session = crypto.randomUUID();
    const ids = [`uacs#web#${accountId}#${session}`, `u#acs#${accountId}#${session}`];   // what the web app sends, then the documented template
    const topics = [
      ...this.cfg.controllers.map(c => `d/rt-events/${c}`),
      ...this.cfg.controllers.map(c => `d/settings/${c}`),
      `b/notify/${this.cfg.org}`,
    ];
    let client = null, lastErr = null;
    for (const clientId of ids) {
      const c = new Mqtt5({ url, username: accountId, password: m.token, clientId, origin: H.app });
      c.on('error', e => { this.mq.error = e.message; });
      try { await c.connect(); client = c; break; } catch (e) { lastErr = e; c.removeAllListeners(); c.on('error', () => {}); c.close(); if (!/client id|not authorized|bad username/i.test(e.message)) break; }
    }
    if (!client) throw lastErr || new Error('MQTT connect failed');
    if (this.stopped) { client.close(); return; }
    this.mqtt = client;
    const acked = await client.subscribe(topics);
    this.mq = {
      ...this.mq, state: 'connected', error: acked.some(a => !a.ok) ? `Broker refused ${acked.filter(a => !a.ok).length} of ${acked.length} topics` : null,
      host, topics, acked, connectedAt: Date.now(), tokenExpiry: m.expiry ? Number(m.expiry) * 1000 : null,
    };
    this._retries = 0;
    this.log(`[Trace] cloud push connected to ${host} (${acked.filter(a => a.ok).length}/${acked.length} topics)`);
    client.on('message', msg => this._onMessage(msg));
    client.on('state', s => {
      if (s === 'closed' && !this.stopped && this.mqtt === client) { this.mqtt = null; this.mq.state = 'closed'; this._scheduleRetry(); }
    });
    // Renew before the 60 h messaging token runs out.
    if (this.mq.tokenExpiry) {
      const inMs = Math.max(60000, this.mq.tokenExpiry - Date.now() - 10 * 60000);
      clearTimeout(this._renew);
      this._renew = setTimeout(() => { if (this.mqtt === client) { this.mqtt = null; client.removeAllListeners(); client.close(); this._connect().catch(e => { this.mq.error = e.message; this._scheduleRetry(); }); } }, Math.min(inMs, 2 ** 31 - 1));
      if (this._renew.unref) this._renew.unref();
    }
  }

  _onMessage({ topic, payload, at }) {
    this.mq.received++; this.mq.lastAt = at;
    let j = null;
    const text = payload.toString('utf8');
    try { j = JSON.parse(text); } catch { j = null; }
    const events = j ? fromCloud(j, { src: 'cloud-mqtt', at, topic }) : [];
    this.emit('raw', { topic, at, json: j, text: j ? null : text.slice(0, 4000) });
    for (const e of events) this.emit('event', e, j);
  }

  _startPoll() {
    const o = lib();
    const H = this.H;
    const base = H.io.replace('/acsio/', '/acstimeline/');
    const first = { done: false };
    this.poll = { state: 'running', error: null, lastAt: null, seen: 0, ms: this.cfg.pollMs };
    const tick = async () => {
      if (this.stopped || this._polling) return;
      this._polling = true;
      const t0 = Date.now();
      try {
        const url = `${base}/${this.cfg.org}/door/events?from=0&size=30&untilTime=${Date.now() + 60000}&eventTypes=&doorIds=${this.cfg.doors.join(',')}`;
        const d = await o.api(H, url);
        const items = (d && (d.events || (Array.isArray(d) ? d : []))) || [];
        const at = Date.now();
        for (const it of items) {
          const key = (it.eventMeta && it.eventMeta.eventId) || `${it.eventTimestamp}|${it.doorId}|${JSON.stringify(it.eventMeta && it.eventMeta.events || '').slice(0, 200)}`;
          if (this._seen.has(key)) continue;
          this._seen.set(key, at);
          if (this._seen.size > 5000) this._seen.delete(this._seen.keys().next().value);
          if (!first.done) continue;           // history present before we started is not "new"
          this.poll.seen++;
          for (const e of fromCloud(it, { src: 'cloud-api', at })) { e.pollMs = at - t0; this.emit('event', e, it); }
        }
        first.done = true;
        this.poll.lastAt = at; this.poll.error = null; this.poll.state = 'running';
      } catch (e) {
        this.poll.error = e.message; this.poll.state = 'error';
      } finally { this._polling = false; }
    };
    tick();
    this._pollTimer = setInterval(tick, this.cfg.pollMs);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }
}

module.exports = { CloudFeed, isCamera };
