// Event Trace tests (AETHER_TRACE). Run from a COPY of backend/ (it writes data/):
//   NODE_PATH=<dir with ws, express> node tests/trace.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const { scrub, hasSecrets, Vault } = require('../trace/redact');
const { Mqtt5, decodePublishes, _internal: M } = require('../trace/mqtt5');
const { fromCloud, fromJournal, fromReport, normType } = require('../trace/normalize');
const { correlate } = require('../trace/correlate');

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── mock MQTT 5 broker over WebSocket ──────────────────────────────────────
function mockBroker({ user, pass, refuseIds = [] } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, handleProtocols: p => (p.has('mqtt') ? 'mqtt' : false) });
  const b = { server, clients: new Set(), subs: new Map(), connects: [], port: 0 };
  wss.on('connection', ws => {
    let buf = Buffer.alloc(0);
    ws.on('message', data => {
      buf = Buffer.concat([buf, data]);
      for (;;) {
        if (buf.length < 2) return;
        const l = M.readVarint(buf, 1); if (!l) return;
        const total = l.next + l.val; if (buf.length < total) return;
        const first = buf[0], body = buf.subarray(l.next, total); buf = buf.subarray(total);
        const type = first >> 4;
        if (type === 1) {
          let i = 2 + body.readUInt16BE(0); const ver = body[i++]; const flags = body[i++]; i += 2;
          const pl = M.readVarint(body, i); i = pl.next + pl.val;
          const rs = () => { const n = body.readUInt16BE(i); const s = body.toString('utf8', i + 2, i + 2 + n); i += 2 + n; return s; };
          const cid = rs(); const u = flags & 0x80 ? rs() : null; const p = flags & 0x40 ? rs() : null;
          b.connects.push({ ver, cid, u, p });
          const bad = (user && u !== user) || (pass && p !== pass);
          const refuse = refuseIds.some(x => cid.startsWith(x));
          ws.send(M.packet(0x20, Buffer.from([0, bad ? 0x86 : refuse ? 0x85 : 0, 0])));
          if (!bad && !refuse) b.clients.add(ws);
        } else if (type === 8) {
          const id = body.readUInt16BE(0); let i = 2; const pl = M.readVarint(body, i); i = pl.next + pl.val;
          const codes = [];
          while (i < body.length) { const n = body.readUInt16BE(i); const t = body.toString('utf8', i + 2, i + 2 + n); i += 3 + n; b.subs.set(t, ws); codes.push(t.includes('forbidden') ? 0x87 : 0); }
          const pid = Buffer.alloc(2); pid.writeUInt16BE(id);
          ws.send(M.packet(0x90, Buffer.concat([pid, Buffer.from([0]), Buffer.from(codes)])));
        } else if (type === 12) ws.send(Buffer.from([0xD0, 0]));
      }
    });
    ws.on('close', () => b.clients.delete(ws));
  });
  b.publish = (topic, obj, { qos = 0, alias = 0, aliasOnly = false } = {}) => {
    const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
    const parts = [M.str(aliasOnly ? '' : topic)];
    if (qos) { const pid = Buffer.alloc(2); pid.writeUInt16BE(7); parts.push(pid); }
    if (alias) { const a = Buffer.alloc(2); a.writeUInt16BE(alias); parts.push(M.varint(3), Buffer.from([0x23]), a); } else parts.push(M.varint(0));
    parts.push(payload);
    const pkt = M.packet(0x30 | (qos << 1), Buffer.concat(parts));
    for (const ws of b.clients) ws.send(pkt);
  };
  b.listen = () => new Promise(r => server.listen(0, '127.0.0.1', () => { b.port = server.address().port; r(b); }));
  b.close = () => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(); };
  return b;
}

(async () => {
  console.log('redact');
  {
    const raw = {
      msg: { properties: { RequestHeader: ['Authorization:Bearer eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE3OTI0NjA4MDB9.ucB86g853kZw7e4QUUqZkP', 'Accept: */*'], Content: { accessToken: 'abc123456789', refreshToken: 'zzz999888777', isTemporary: false } } },
      url: 'https://s3/x.json?X-Amz-Security-Token=SECRET&X-Amz-Signature=deadbeef&ok=1',
      pin: '1234', cardNumber: '9876', note: 'token=eyJabcdefghij.eyJklmnopqrstu.sigsigsigsig',
    };
    const s = scrub(raw);
    const txt = JSON.stringify(s);
    assert(!txt.includes('ucB86g') && !txt.includes('eyJhbGci'), 'Bearer inside array removed');
    assert(txt.includes('Bearer [redacted]'));
    assert(s.msg.properties.Content.accessToken.startsWith('[redacted'));
    assert(s.msg.properties.Content.isTemporary === false);
    assert(!txt.includes('SECRET') && !txt.includes('deadbeef') && txt.includes('ok=1'));
    assert(s.pin.startsWith('[redacted') && s.cardNumber === '9876', 'PIN hidden, card number kept');
    assert(!txt.includes('eyJklmnop'));
    assert(hasSecrets(raw) && !hasSecrets({ a: 1, cardNumber: '5' }));
    ok('Bearer in arrays, JWTs, tokens, PIN and S3 signatures are scrubbed; card numbers kept');
    const dir = fs.mkdtempSync('/tmp/vault-');
    const v = new Vault(dir); v.put('e1', raw);
    const v2 = new Vault(dir);
    assert.deepStrictEqual(v2.reveal('e1', 'tester'), raw);
    assert((fs.statSync(path.join(dir, 'vault.jsonl')).mode & 0o777) === 0o600);
    assert.strictEqual(v2.reveals()[0].who, 'tester');
    ok('vault keeps originals mode 600 and logs every reveal');
  }

  console.log('mqtt5');
  {
    const br = await mockBroker({ user: 'acct', pass: 'tok' }).listen();
    const c = new Mqtt5({ url: `ws://127.0.0.1:${br.port}/mqtt`, username: 'acct', password: 'tok', clientId: 'uacs#web#acct#s1' });
    await c.connect();
    assert.strictEqual(br.connects[0].ver, 5);
    assert.strictEqual(br.connects[0].cid, 'uacs#web#acct#s1');
    const subs = await c.subscribe(['d/rt-events/c1', 'd/settings/c1', 'b/notify/forbidden']);
    assert.deepStrictEqual(subs.map(s => s.ok), [true, true, false]);
    const got = [];
    c.on('message', m => got.push(m));
    br.publish('d/rt-events/c1', { a: 1 }, { alias: 4 });
    br.publish('', { a: 2 }, { alias: 4, aliasOnly: true });
    br.publish('d/settings/c1', { a: 3 }, { qos: 1 });
    await sleep(150);
    assert.deepStrictEqual(got.map(g => [g.topic, JSON.parse(g.payload).a]), [['d/rt-events/c1', 1], ['d/rt-events/c1', 2], ['d/settings/c1', 3]]);
    assert(got.every(g => g.at > Date.now() - 5000));
    c.close();
    const bad = new Mqtt5({ url: `ws://127.0.0.1:${br.port}/mqtt`, username: 'acct', password: 'nope', clientId: 'x' });
    await assert.rejects(bad.connect(), /bad username or password/);
    br.close();
    ok('connects (MQTT 5), subscribes, topic aliases, QoS 1, refused login reported');
    const pkt = Buffer.concat([M.packet(0x30, Buffer.concat([M.str('d/rt-events/x'), M.varint(0), Buffer.from('{"q":1}')])), Buffer.from([0xD0, 0])]);
    const d = decodePublishes(pkt);
    assert.strictEqual(d[0].topic, 'd/rt-events/x'); assert.strictEqual(JSON.parse(d[0].payload).q, 1);
    ok('decodes captured PUBLISH frames (HAR import)');
  }

  console.log('normalize');
  {
    // timeline API item (shape from the HAR survey)
    const item = { eventTimestamp: 1793837501029, doorId: 'd-1', doorName: 'Front', cardNumber: '01234', facilityCode: '123', cardFormat: '26BIT', clientType: null,
      eventMeta: { controllerId: 'ctrl-1', eventId: 'ev-9', triggerType: 'card', events: [{ event: [{ eventType: 'accessgranted' }] }] }, src: { srcId: 'd-1', type: 'door' } };
    const e = fromCloud(item, { src: 'cloud-api', at: 1793837501900 });
    assert.strictEqual(e.length, 1);
    assert.strictEqual(e[0].type, 'accessgranted'); assert(e[0].access);
    assert.deepStrictEqual(e[0].cred, { fc: '123', cn: '01234', format: '26BIT' });
    assert.strictEqual(e[0].t, 1793837501029); assert.strictEqual(e[0].controllerId, 'ctrl-1'); assert.strictEqual(e[0].eventId, 'ev-9');
    // Cloud Connector RealTime payload (t + nested events), dotted v2 type
    const cc = { t: 1793837600000, src: { srcId: 'd-2', type: 'door' }, eventMeta: { eventId: 'x', events: [{ event: [{ eventType: 'Door.AccessDenied' }, { eventType: 'unlocked' }] }] } };
    const e2 = fromCloud(cc, { topic: 'd/rt-events/ctrl-9', at: 1 });
    assert.deepStrictEqual(e2.map(x => x.type), ['accessdenied', 'unlocked']);
    assert.strictEqual(e2[0].controllerId, 'ctrl-9'); assert.strictEqual(e2[0].door.id, 'd-2');
    // d/settings and b/notify
    const s = fromCloud({ tid: '1792457234669', msg: { action: 'is', resource: 'controller/c-3', properties: { ioId: 'a#c-3#output_out1', ioState: 'active' } } }, { topic: 'd/settings/c-3', at: 2 });
    assert.strictEqual(s[0].type, 'io-active'); assert.strictEqual(s[0].controllerId, 'c-3'); assert.strictEqual(s[0].clock, 'cloud');
    const n = fromCloud({ msgs: [{ msg: { action: 'update', resource: 'door/d-7', propertyDetails: { doorId: 'd-7', modifiedDate: 1792457233815, state: { DoorPhysicalState: 'Closed', LockPhysicalState: 'Locked' } } } }] }, { at: 3 });
    assert.strictEqual(n[0].type, 'door-state'); assert.strictEqual(n[0].cloudAt, 1792457233815);
    assert.strictEqual(normType('Panel.TamperActive'), 'tamperactive');
    const j = fromJournal({ t: 5, k: 'card', ch: 'wiegand:r1', v: 1, src: 'wiegand', m: { fc: 123, cn: 1234, format: 'w26' } });
    assert.deepStrictEqual(j.cred, { fc: '123', cn: '1234', format: 'w26' });
    const r = fromReport({ events: [{ t: 10, logT: 60, type: 'accessgranted', src: 'ap1' }], doors: { ap1: { name: 'Lab' } } });
    assert.strictEqual(r[0].publishAt, 60); assert.strictEqual(r[0].door.name, 'Lab');
    ok('timeline items, Cloud Connector payloads, I/O and door-state pushes, journal and Log Analytics reports');
  }

  console.log('correlate');
  {
    const OFF = 1234;   // controller clock runs 1.234 s ahead of the Pi
    const ev = [];
    const T = 1_800_000_000_000;
    const journal = (at, fc, cn) => ev.push(fromJournal({ t: at, k: 'card', ch: 'wiegand:r1', v: 1, src: 'wiegand', m: { fc, cn, format: 'w26' } }));
    const cloud = (ctrlT, type, fc, cn, pushAt, id, extra = {}) => {
      const e = fromCloud({ eventTimestamp: ctrlT, cardNumber: cn == null ? undefined : String(cn), facilityCode: fc == null ? undefined : String(fc), doorId: 'd1', eventMeta: { eventId: id, events: [{ event: [{ eventType: type }] }] } }, { src: 'cloud-mqtt', at: pushAt })[0];
      Object.assign(e, extra); ev.push(e); return e;
    };
    const syncs = [];
    // start pair: sent at T and T+2000, decision 40 ms later, pushed ~700 ms later
    for (const [i, at] of [[0, T], [1, T + 2000]]) {
      syncs.push({ at: at - 5, fc: 123, cn: i ? '9876' : '1234', set: 'start', idx: i });
      journal(at, 123, i ? 9876 : 1234);
      cloud(at + 40 + OFF, 'accessgranted', 123, i ? 9876 : 1234, at + 700, 'sync-s' + i);
    }
    // test actions
    journal(T + 10000, 55, 1001); cloud(T + 10000 + 60 + OFF, 'accessgranted', 55, 1001, T + 10000 + 800, 'a1');
    const api = fromCloud({ eventTimestamp: T + 10000 + 60 + OFF, cardNumber: '1001', facilityCode: '55', doorId: 'd1', eventMeta: { eventId: 'a1', events: [{ event: [{ eventType: 'accessgranted' }] }] } }, { src: 'cloud-api', at: T + 10000 + 2100 })[0];
    api.pollMs = 2000; ev.push(api);
    journal(T + 20000, 55, 1002); cloud(T + 20000 + 2600 + OFF, 'accessgranted', 55, 1002, T + 20000 + 3400, 'a2');          // slow decision (fail)
    journal(T + 30000, 55, 1003); cloud(T + 30000 + 50 + OFF, 'accessgranted', 55, 1300, T + 30000 + 900, 'a3');           // decoded wrong
    journal(T + 40000, 77, 5); cloud(T + 40000 + 50 + OFF, 'accessdenied_unauthorized', 77, 5, T + 40000 + 600, 'a4');    // expected grant
    journal(T + 50000, 55, 1005);                                                                                       // never reached the cloud
    cloud(T + 60000 + OFF, 'doorforcedopen', null, null, T + 60500, 'x1', { access: false });
    cloud(T + 61000 + OFF, 'accessgranted', 9, 9, T + 61700, 'nobody');                                                // unexplained
    // end pair 2 min later, clock drifted +120 ms
    for (const [i, at] of [[0, T + 120000], [1, T + 122000]]) {
      syncs.push({ at: at - 5, fc: 123, cn: i ? '9876' : '1234', set: 'end', idx: i });
      journal(at, 123, i ? 9876 : 1234);
      cloud(at + 40 + OFF + 120, 'accessgranted', 123, i ? 9876 : 1234, at + 700, 'sync-e' + i);
    }
    // wire egress after action a1
    ev.push({ id: 'w1', src: 'wire', lane: 'wire', at: T + 10000 + 120, t: T + 10000 + 120, clock: 'pi', type: 'egress', dir: 'out', label: '↑ 312 B', access: false });
    // controller log copy of a1 with publish time
    ev.push(...fromReport({ events: [{ t: T + 10000 + 60 + OFF, logT: T + 10000 + 95 + OFF, type: 'accessgranted', src: 'd1' }] }));

    const r = correlate(ev, syncs, { expectations: [{ fc: '77', cn: '5', expect: 'grant' }], thresholds: {} });
    assert.strictEqual(r.clock.offset, OFF + 40, 'offset from the start pair (includes 40 ms decode)');
    assert.strictEqual(r.clock.drift.changeMs, 120);
    assert(Math.abs(r.clock.drift.perHourMs - 3600) < 1, 'drift per hour');
    assert.strictEqual(r.clock.gaps[0].sent, 2000); assert.strictEqual(r.clock.gaps[0].seen, 2000);
    const by = cn => r.traces.find(t => t.action.cred && t.action.cred.cn === String(cn));
    const a1 = by(1001);
    assert.strictEqual(a1.status, 'pass', JSON.stringify(a1.notes));
    assert.strictEqual(a1.latency.decision, 20, 'decision corrected by the offset');
    assert.strictEqual(a1.latency.push, 800); assert.strictEqual(a1.latency.api, 2100);
    assert.deepStrictEqual(a1.hops.map(h => h.id), ['sent', 'decided', 'published', 'wire', 'push', 'api']);
    assert.strictEqual(a1.hops.find(h => h.id === 'published').ms, 55);
    assert.strictEqual(a1.decision.sources.sort().join(','), 'cloud-api,cloud-mqtt,controller');
    assert.strictEqual(by(1002).status, 'fail'); assert(/Decision took/.test(by(1002).notes.join()));
    assert.strictEqual(by(1003).credCheck, 'mismatch'); assert.strictEqual(by(1003).status, 'fail');
    assert.strictEqual(by(5).status, 'fail'); assert(/Expected grant/.test(by(5).notes.join()));
    assert.strictEqual(by(1005).status, 'fail'); assert(!by(1005).decision);
    assert(r.traces.filter(t => t.sync).length === 4);
    assert.deepStrictEqual(r.unexplained.map(u => u.cred && u.cred.cn), ['9']);
    assert.strictEqual(r.stats.actions, 5); assert.strictEqual(r.stats.pass, 1); assert.strictEqual(r.stats.verdict, 'fail');
    ok('offset + drift from sync pairs, corrected decision time, push/API/wire/publish hops, credential mismatch, expectations, unexplained');

    // credential-less cloud events: the gap pattern still finds the sync pair
    const ev2 = [], syn2 = [];
    for (const [i, at] of [[0, T], [1, T + 3000]]) {
      syn2.push({ at, fc: 1, cn: String(10 + i), set: 'start', idx: i });
      ev2.push(fromCloud({ eventTimestamp: at + 500, eventMeta: { eventId: 'p' + i, events: [{ event: [{ eventType: 'accessgranted' }] }] } }, { src: 'cloud-mqtt', at: at + 900 })[0]);
    }
    ev2.push(fromCloud({ eventTimestamp: T + 1200, eventMeta: { eventId: 'noise', events: [{ event: [{ eventType: 'accessgranted' }] }] } }, { src: 'cloud-mqtt', at: T + 1500 })[0]);
    const r2 = correlate(ev2, syn2, {});
    assert.strictEqual(r2.clock.offset, 500); assert(r2.clock.sync.every(x => x.byPattern));
    ok('sync pair matched by the gap pattern when the cloud omits card numbers');
  }

  console.log('engine (end to end)');
  {
    // fake OnCAFE session helpers + mock broker; the "controller" answers each card through MQTT
    const br = await mockBroker({ user: 'acct-1', pass: 'msg-token' }).listen();
    process.env.AETHER_TRACE_WS_INSECURE = '1';
    const oncafePath = require.resolve('../routes-oncafe');
    const H = { key: 'qa.oncafe.hanwhavision.cloud', app: 'https://qa.oncafe.hanwhavision.cloud', io: 'https://api.qa.oncafe.hanwhavision.cloud/acsio/orgs', device: 'https://d/device/orgs', partner: 'https://p/partner' };
    const apiCalls = [];
    let timeline = [];
    require.cache[oncafePath] = { id: oncafePath, filename: oncafePath, loaded: true, exports: Object.assign(() => {}, {
      hosts: () => H, status: () => ({ signedIn: true }),
      api: async (_H, url) => {
        apiCalls.push(url);
        if (url.endsWith('/platform/v2')) return { acsmqtt: { wsHost: '127.0.0.1', wsPort: String(br.port), username: 'acct-1', token: 'msg-token', expiry: String(Math.floor(Date.now() / 1000) + 3600) } };
        if (url.includes('/acstimeline/')) return { events: timeline };
        if (url.includes('/devices')) return [{ deviceId: '11111111-1111-1111-1111-111111111111', deviceName: 'NHP lab', deviceType: 'acc' }, { deviceId: '22222222-2222-2222-2222-222222222222', deviceName: 'Cam', deviceType: 'ipcam' }];
        if (url.includes('/doors/v2')) return [{ doorId: '33333333-3333-3333-3333-333333333333', doorName: 'Lab door', controllerId: '11111111-1111-1111-1111-111111111111' }];
        return {};
      },
    }) };
    const { TraceEngine } = require('../trace/engine');
    const eng = new TraceEngine();
    const CTRL = '11111111-1111-1111-1111-111111111111', DOOR = '33333333-3333-3333-3333-333333333333', ORG = '44444444-4444-4444-4444-444444444444';
    const inv = await eng.cloud.inventory('https://qa.oncafe.hanwhavision.cloud', ORG);
    assert.deepStrictEqual(inv.controllers.map(c => c.name), ['NHP lab']);
    let evN = 0;
    const respond = (fc, cn) => setTimeout(() => {
      const it = { eventTimestamp: Date.now() + 1500, doorId: DOOR, cardNumber: String(cn), facilityCode: String(fc), cardFormat: '26BIT', clientType: null,
        eventMeta: { controllerId: CTRL, eventId: 'e' + (++evN), events: [{ event: [{ eventType: 'accessgranted' }] }] },
        headers: ['Authorization:Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlMTIz'] };
      br.publish(`d/rt-events/${CTRL}`, it);
      setTimeout(() => { timeline = [it, ...timeline]; }, 150);
    }, 60);
    const wm = { sent: [], getReaders: () => [{ id: 'r1', name: 'Reader 1' }], async sendCard(id, fc, cn, fmt) { this.sent.push([id, fc, cn, fmt]); await sleep(50); respond(fc, cn); return { success: true }; } };
    const journal = require('../analytics/journal');
    journal.attach({ getWiegand: () => wm });
    eng.attach({ getWiegand: () => wm, getOsdp: () => null, emulator: null });
    eng.saveSettings({ cloud: { url: 'https://qa.oncafe.hanwhavision.cloud', org: ORG, controllers: [CTRL], doors: [DOOR], poll: true, pollMs: 1000 },
      sync: { channel: { kind: 'wiegand', readerId: 'r1' }, format: 'w26', cards: [{ fc: 123, cn: 1234 }, { fc: 123, cn: 9876 }], gapsMs: [600, 600] },
      thresholds: { matchWindowMs: 5000 }, expectations: [{ fc: 55, cn: 1001, expect: 'grant' }] });
    const st = await eng.cloud.start(eng.settings.cloud);
    assert.strictEqual(st.push.state, 'connected', st.push.error);
    assert.strictEqual(br.connects.at(-1).cid.startsWith('uacs#web#acct-1#'), true);
    assert(br.subs.has(`d/rt-events/${CTRL}`) && br.subs.has(`b/notify/${ORG}`));
    const run = await eng.startRun('e2e');
    await sleep(1500);   // start pair
    await wm.sendCard('r1', 55, 1001, 'w26');
    await sleep(2300);   // let the poll see it
    const stopped = await eng.stopRun('done');
    assert(stopped.end);
    const a = eng.analyze(run.id);
    const syncT = a.traces.filter(t => t.sync), real = a.traces.filter(t => !t.sync);
    assert.strictEqual(syncT.length, 4, 'start + end pairs traced');
    assert.strictEqual(real.length, 1);
    assert(Math.abs(a.clock.offset - 1500) < 400, 'offset ≈ the fake controller clock lead: ' + a.clock.offset);
    assert.strictEqual(real[0].status, 'pass', real[0].notes.join('; '));
    assert(real[0].latency.push > 0 && real[0].latency.push < 1000, 'push latency ' + real[0].latency.push);
    assert(real[0].latency.api > 0, 'seen by the event-log poll');
    assert(Math.abs(real[0].latency.decision) < 400, 'corrected decision ' + real[0].latency.decision);
    // secrets: events file is scrubbed, vault has the original, reveal is logged
    const evFile = fs.readFileSync(path.join(__dirname, '..', 'data', 'trace', 'runs', run.id, 'events.jsonl'), 'utf8');
    assert(!evFile.includes('c2lnbmF0dXJlMTIz') && evFile.includes('Bearer [redacted]'));
    const ce = eng.readEvents(run.id).find(e => e.src === 'cloud-mqtt' && e.secret);
    const raw = eng.reveal(run.id, ce.id, 'tester');
    assert(JSON.stringify(raw).includes('c2lnbmF0dXJlMTIz'));
    eng.saveSettings({ allowRaw: false });
    assert.throws(() => eng.reveal(run.id, ce.id, 'tester'), /turned off/);
    eng.saveSettings({ allowRaw: true });
    ok('live run: sync pairs → offset, card → MQTT push + event-log poll, scrubbed storage, logged reveal');

    // HAR import into the same run (browser clock)
    const pub = M.packet(0x30, Buffer.concat([M.str(`d/rt-events/${CTRL}`), M.varint(0), Buffer.from(JSON.stringify({ eventTimestamp: Date.now(), cardNumber: '42', facilityCode: '1', eventMeta: { eventId: 'h1', events: [{ event: [{ eventType: 'accessgranted' }] }] } }))]));
    const har = { log: { entries: [
      { startedDateTime: new Date().toISOString(), time: 30, request: { url: `https://api.qa.oncafe.hanwhavision.cloud/acstimeline/orgs/${ORG}/door/events?from=0` }, response: { content: { text: JSON.stringify({ data: { events: [{ eventTimestamp: 1, eventMeta: { eventId: 'h2', events: [{ event: [{ eventType: 'locked' }] }] } }] } }) } } },
      { startedDateTime: new Date().toISOString(), time: 1, request: { url: 'wss://messaging-ext.qa.oncafe.hanwhavision.cloud/mqtt' }, response: {}, _webSocketMessages: [{ type: 'receive', opcode: 2, time: Date.now() / 1000, data: pub.toString('base64') }] },
    ] } };
    const im = eng.importHar(run.id, JSON.stringify(har));
    assert.strictEqual(im.imported, 2);
    assert(eng.readEvents(run.id).some(e => e.src === 'har' && e.harVia === 'mqtt' && e.cred && e.cred.cn === '42'));
    ok('HAR import: event-log responses and MQTT frames');

    // Express routes
    const express = require('express');
    const app = express();
    app.use('/api/trace', express.json({ limit: '20mb' }));
    app.use(express.json());
    app.use('/api/trace', require('../routes/trace')());
    const srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}/api/trace`;
    const s = await (await fetch(base + '/status')).json();
    assert(s.sources && s.channels.wiegand.length >= 0);
    const runs = await (await fetch(base + '/runs')).json();
    assert(Array.isArray(runs.runs));
    const csv = await (await fetch(`${base}/runs/${runs.runs[0].id}/export.csv`)).text();
    assert(csv.startsWith('time,status'));
    const big = { packets: Array.from({ length: 3000 }, (_, i) => ({ ts: Date.now() + i, src: '10.0.0.5', dst: '3.3.3.3', sport: 5000, dport: 443, bytes: 100 })) };
    eng.saveSettings({ wire: { controllerIps: ['10.0.0.5'] } });
    const wr = await (await fetch(`${base}/runs/${runs.runs[0].id}/import/wire`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(big) })).json();
    assert.strictEqual(wr.imported, 3000);
    srv.close();
    ok('routes: status, runs, CSV export, 3000-packet wire import past the global 100 kB JSON limit');

    // review fixes: run ids, label scrubbing, stop/start race
    for (const bad of ['../../../tmp/x', '..%2Fx', 'trace-abc/../../x']) {
      assert.throws(() => eng.importWire(bad, []), /Bad run id/);
      assert.throws(() => eng.analyze(bad), /Bad run id/);
      assert.throws(() => eng.reveal(bad, 'e', 'x'), /Bad run id/);
    }
    const le = eng.add({ id: 'lbl', src: 'wire', lane: 'wire', at: Date.now(), t: Date.now(), clock: 'pi', type: 'egress-http', label: 'GET host/api?access_token=SEKRIT&x=1', info: { hdr: ['Authorization', 'Bearer abcdefghijkl'] } });
    assert(!JSON.stringify(le).includes('SEKRIT') && !JSON.stringify(le).includes('abcdefghijkl'));
    eng.saveSettings({ sync: { atStart: false, atEnd: true, gapsMs: [500, 500] } });
    const rA = await eng.startRun('A');
    const stopping = eng.stopRun('done');          // waits for its end sync
    await sleep(200);
    const rB = await eng.startRun('B', { sync: false });
    await stopping;
    assert.strictEqual(eng.run && eng.run.id, rB.id, 'stopping A must not stop B');
    await eng.stopRun('done', { sync: false });
    assert(rA.id !== rB.id);
    ok('review: run ids validated, labels scrubbed, stopping one run never stops the next');

    await eng.cloud.stop();
    br.close();
  }

  console.log('correlate (review fixes)');
  {
    const T = 1_900_000_000_000;
    const card = (at, cn) => fromJournal({ t: at, k: 'card', ch: 'wiegand:r1', v: 1, src: 'wiegand', m: { fc: 1, cn } });
    const dec = (t, id) => fromCloud({ eventTimestamp: t, eventMeta: { eventId: id, events: [{ event: [{ eventType: 'accessgranted' }] }] } }, { src: 'cloud-mqtt', at: t + 500 })[0];
    // card A's decision is lost; B's must stay with B
    const r = correlate([card(T, 1), card(T + 5000, 2), dec(T + 5040, 'b')], [], {});
    const A = r.traces.find(t => t.action.cred.cn === '1'), Bt = r.traces.find(t => t.action.cred.cn === '2');
    assert(!A.decision, 'A has no decision'); assert(Bt.decision && Bt.decision.t === T + 5040);
    // test cards 2 s apart must not be taken as the sync pair: the pair nearest the sync send wins
    const syn = [{ at: T, fc: 9, cn: '1', set: 'start', idx: 0, batch: 'x' }, { at: T + 2000, fc: 9, cn: '2', set: 'start', idx: 1, batch: 'x' }];
    const ev = [dec(T + 300, 's1'), dec(T + 2300, 's2'), dec(T + 60000, 't1'), dec(T + 62000, 't2')];
    const r2 = correlate(ev, syn, {});
    assert.strictEqual(r2.clock.offset, 300);
    ok('lost decisions are not blamed on the next card; sync pair = nearest matching pair of one send');
  }

  console.log('TRACE-2: inputs, outputs, commands');
  {
    const { parseCommand, buildRequest, reverseOf, localStamp } = require('../trace/commands');
    const { commandEvent } = require('../trace/commands');
    const ORG = '44444444-4444-4444-4444-444444444444', DOOR = '33333333-3333-3333-3333-333333333333', AREA = '77777777-7777-7777-7777-777777777777', Z = '88888888-8888-8888-8888-888888888888';
    const B = `https://api.qa.oncafe.hanwhavision.cloud/acsio/orgs/${ORG}`;
    assert.deepStrictEqual(parseCommand('PUT', `${B}/area/${AREA}/lockdown`, '{"lockdown":true}'), { kind: 'lockdown', target: AREA, value: true, area: undefined, org: ORG });
    const ov = parseCommand('POST', `${B}/entity/temporaryOverride`, { areaId: AREA, temporaryOverrideSchedule: [{ doorId: DOOR, behaviour: 'unlock', enable: true }] });
    assert.deepStrictEqual([ov.kind, ov.target, ov.value, ov.area], ['override', [DOOR], 'unlock', AREA]);
    assert.strictEqual(parseCommand('PUT', `${B}/zone/${Z}/outputzone/state`, '{"state":"activate"}').value, 'activate');
    assert.strictEqual(parseCommand('PUT', `${B}/door/${DOOR}/manageMaintenanceMode`, '{"maintenanceState":true}').kind, 'maintenance');
    assert.strictEqual(parseCommand('GET', `${B}/area/${AREA}/lockdown`, null), null);
    assert.strictEqual(localStamp(Date.UTC(2026, 9, 20, 0, 47, 13), 'Asia/Seoul'), '20261020T094713');
    const rq = buildRequest({ kind: 'override', target: DOOR, value: 'unlock', area: AREA, seconds: 10 }, { tz: 'UTC' });
    const ve = rq.body.temporaryOverrideSchedule[0].standard.vcalendar[0].vevent[0];
    assert.strictEqual(rq.path, '/entity/temporaryOverride');
    assert.strictEqual(Date.parse(ve.dtend.replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)/, '$1-$2-$3T$4:$5:$6Z')) - Date.parse(ve.dtstart.replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)/, '$1-$2-$3T$4:$5:$6Z')), 10000);
    assert.deepStrictEqual(reverseOf({ kind: 'lockdown', target: AREA, value: true }).value, false);
    ok('commands: recognised from the web app requests, built with site-local times, reversed');

    // a timeline: controller clock 1 s ahead; DPS pulse sync on relay:6 (mapped dps, door D), REX, card + strike, lockdown, unlock override
    const OFF = 1000, T = 2_000_000_000_000;
    const wiring = { 'relay:6': { role: 'dps', door: DOOR, active: 'open' }, 'relay:7': { role: 'rex', door: DOOR }, 'opto:2': { role: 'lock', door: DOOR } };
    const ev = [];
    const J = (at, k, ch, v, m) => { const e = fromJournal({ t: at, k, ch, v, src: 'physical', m }); ev.push(e); return e; };
    const C = (ctrlT, type, extra = {}, at = ctrlT - OFF + 700) => { const e = fromCloud({ eventTimestamp: ctrlT, doorId: DOOR, ...extra, eventMeta: { eventId: type + ctrlT, triggerType: extra.trigger, events: [{ event: [{ eventType: type }] }] } }, { src: 'cloud-mqtt', at })[0]; ev.push(e); return e; };
    // sync pulse: relay:6 on 2 s, off
    J(T, 'relay', 'relay:6', 1); C(T + OFF + 30, 'open');
    J(T + 2000, 'relay', 'relay:6', 0); C(T + 2000 + OFF + 30, 'closed');
    const syncs = [{ at: T - 5, set: 'start', idx: 0, batch: 'p', ch: 'relay:6', v: 1, types: ['open', 'doorforcedopen', 'dooropen'], door: DOOR },
      { at: T + 1995, set: 'start', idx: 1, batch: 'p', ch: 'relay:6', v: 0, types: ['closed', 'doorclosed'], door: DOOR }];
    // REX press
    J(T + 10000, 'relay', 'relay:7', 1); C(T + 10000 + OFF + 40, 'rexactivated');
    J(T + 10500, 'relay', 'relay:7', 0);
    // card granted → strike on 5.2 s (door set to 5 s) → door opened while unlocked, still reported forced → fail
    J(T + 20000, 'card', 'wiegand:r1', 1, { fc: 1, cn: 5 }); C(T + 20000 + OFF + 50, 'accessgranted', { cardNumber: '5', facilityCode: '1' });
    C(T + 20000 + OFF + 60, 'unlocked'); J(T + 20000 + 110, 'opto', 'opto:2', 1);
    J(T + 22000, 'relay', 'relay:6', 1); C(T + 22000 + OFF + 30, 'doorforcedopen');
    J(T + 25310, 'opto', 'opto:2', 0); C(T + 25300 + OFF, 'locked');
    J(T + 26000, 'relay', 'relay:6', 0); C(T + 26000 + OFF + 30, 'closed');
    // strike fires with nothing asking for it
    J(T + 40000, 'opto', 'opto:2', 1); J(T + 41000, 'opto', 'opto:2', 0);
    // Aether sends a temporary unlock: OnCAFE acks in 400 ms, controller unlocks, door state updates, strike fires
    ev.push(commandEvent({ kind: 'override', target: [DOOR], value: 'unlock', area: AREA }, { src: 'command', at: T + 50000, ackMs: 400, status: 200 }));
    C(T + 50000 + OFF + 900, 'unlocked', { trigger: 'manual', clientType: 'Browser' });
    J(T + 50000 + 1000, 'opto', 'opto:2', 1);
    ev.push(fromCloud({ msgs: [{ msg: { action: 'update', resource: `door/${DOOR}`, propertyDetails: { doorId: DOOR, modifiedDate: T + 51200, state: { DoorPhysicalState: 'Closed', LockPhysicalState: 'Unlocked' } } } }] }, { src: 'cloud-mqtt', at: T + 51500 })[0]);
    // a lockdown command seen in a HAR that the controller never acted on
    ev.push(commandEvent({ kind: 'lockdown', target: AREA, value: true }, { src: 'har', at: T + 70000, clock: 'browser', ackMs: 800, status: 200 }));
    // an unmapped relay whose pattern says "REX"
    J(T + 80000, 'relay', 'relay:9', 1); C(T + 80000 + OFF + 20, 'rexactivated', { doorId: '99999999-9999-9999-9999-999999999999' });

    const r = correlate(ev, syncs, { doorConfig: { [DOOR]: { grantMs: 5000 } } }, { wiring });
    assert.strictEqual(r.clock.offset, OFF + 30, 'offset from the DPS pulse');
    assert.strictEqual(r.clock.gaps[0].sent, 2000);
    const ins = r.traces.filter(t => t.kind === 'input' && !t.sync);
    const rex = ins.find(t => t.action.ch === 'relay:7' && t.action.v === 1);
    assert.strictEqual(rex.status, 'pass', rex.notes.join()); assert.strictEqual(rex.latency.decision, 10); assert.strictEqual(rex.latency.push, 740);
    const forced = ins.find(t => t.result === 'doorforcedopen');
    assert.strictEqual(forced.status, 'fail'); assert(/while the strike \(opto:2\) was unlocked/.test(forced.notes.join()));
    assert.strictEqual(r.roles['relay:9'].role, 'rex'); assert(r.roles['relay:9'].auto);
    const outs = r.traces.filter(t => t.kind === 'output');
    const strike = outs.find(t => t.action.v === 1 && t.cause && t.cause.kind === 'card');
    assert(strike, 'strike caused by the granted card');
    assert.strictEqual(strike.latency.hardware, 80, 'strike 80 ms after the corrected "unlocked"');
    const off2 = outs.find(t => t.action.v === 0 && t.held != null && t.held > 5000);
    assert.strictEqual(off2.held, 5200); assert.strictEqual(off2.status, 'pass', off2.notes.join());
    const rogue = outs.find(t => t.action.v === 1 && !t.cause);
    assert.strictEqual(rogue.status, 'warn'); assert(/nothing Aether saw asked/.test(rogue.notes.join()));
    const cmd = r.traces.find(t => t.kind === 'command' && t.action.cmd.kind === 'override');
    assert.strictEqual(cmd.status, 'pass', cmd.notes.join());
    assert.deepStrictEqual(cmd.hops.map(h => h.id), ['sent', 'ack', 'decided', 'lock', 'state', 'push']);
    assert.strictEqual(cmd.latency.output, 1000); assert.strictEqual(cmd.latency.ack, 400); assert.strictEqual(cmd.latency.decision, 870);
    const cmdStrike = outs.find(t => t.cause && t.cause.kind === 'command');
    assert(cmdStrike, 'strike traced back to the command');
    const lk = r.traces.find(t => t.kind === 'command' && t.action.cmd.kind === 'lockdown');
    assert.strictEqual(lk.status, 'fail'); assert(/never reported lockdown on/.test(lk.notes.join()));
    assert.strictEqual(r.stats.byKind.command.actions, 2); assert.strictEqual(r.stats.byKind.input.fail, 1);
    ok('DPS pulse sync, REX/DPS input traces, forced-open-after-grant, role inference, strike cause + held time, rogue output, command traces (Aether-sent and HAR)');

    // engine: commands gated, scoped to doors under test, sent with the OnCAFE session, auto-reverted; wiring shared
    const { TraceEngine } = require('../trace/engine');
    const eng = new TraceEngine();
    eng.saveSettings({ cloud: { url: 'https://qa.oncafe.hanwhavision.cloud', org: ORG, doors: [DOOR] }, commands: { enabled: false } });
    eng.cloud.inv = { org: ORG, at: Date.now(), doors: [{ id: DOOR, name: 'Lab door', areaIds: [AREA] }], areas: [{ id: AREA, name: 'Lab', tz: 'UTC' }], zones: [{ id: Z, name: 'Siren' }], controllers: [] };
    const sentReq = [];
    eng.cloud.command = async (_u, _o, req) => { sentReq.push(req); return { ok: true, status: 200, ackMs: 321, data: { success: true } }; };
    await assert.rejects(eng.command({ kind: 'lockdown', target: AREA, value: true }, 't'), /turned off/);
    eng.saveSettings({ commands: { enabled: true } });
    await assert.rejects(eng.command({ kind: 'maintenance', target: '12121212-1212-1212-1212-121212121212', value: true }, 't'), /doors under test/);
    await assert.rejects(eng.command({ kind: 'lockdown', target: '12121212-1212-1212-1212-121212121212', value: true }, 't'), /area that holds a door under test/);
    const res1 = await eng.command({ kind: 'lockdown', target: AREA, value: true, revertSec: 1 }, 'tester');
    assert(res1.ok && res1.revertIn === 1);
    assert.deepStrictEqual(sentReq[0], { method: 'PUT', path: `/area/${AREA}/lockdown`, body: { lockdown: true } });
    await sleep(1300);
    assert.deepStrictEqual(sentReq[1].body, { lockdown: false }, 'reverted');
    const cmds = eng.live.filter(e => e.type === 'command');
    assert.strictEqual(cmds.length, 2); assert.strictEqual(cmds[0].info.ackMs, 321); assert(/tester/.test(cmds[0].info.by));
    // wiring is shared with Log Analytics settings and keeps its other keys
    const ap = path.join(__dirname, '..', 'data', 'analytics', 'settings.json');
    fs.mkdirSync(path.dirname(ap), { recursive: true });
    fs.writeFileSync(ap, JSON.stringify({ thresholds: { latencyWarnMs: 1234 }, wiring: {} }));
    eng.saveWiring({ 'relay:6': { role: 'dps', door: DOOR, active: 'open' }, 'bad key!': { role: 'dps' }, 'opto:2': { role: 'nonsense' } });
    const back = JSON.parse(fs.readFileSync(ap, 'utf8'));
    assert.strictEqual(back.thresholds.latencyWarnMs, 1234); assert.deepStrictEqual(Object.keys(back.wiring), ['relay:6']);
    assert.strictEqual(eng.wiring()['relay:6'].role, 'dps');
    // pulse sync drives the relay through the GPIO queue
    const q = { calls: [], async enqueue(op, ch, v) { this.calls.push([op, ch, v]); } };
    eng.deps = { gpioQueue: q };
    eng.saveSettings({ sync: { channel: { kind: 'relay', relay: 6 }, gapsMs: [500, 500] } });
    const sent = await eng.sendSync('check');
    assert.deepStrictEqual(q.calls, [['setRelay', 6, true], ['setRelay', 6, false]]);
    assert.deepStrictEqual(sent.map(x => [x.ch, x.v]), [['relay:6', 1], ['relay:6', 0]]);
    eng.saveSettings({ sync: { channel: { kind: 'relay', relay: 3 } } });
    await assert.rejects(eng.sendSync('check'), /Map relay:3/);
    // review fixes: only "on" commands are turned back; zones are scoped; turn-backs survive a restart
    const before = sentReq.length;
    const off = await eng.command({ kind: 'lockdown', target: AREA, value: false, revertSec: 1 }, 'tester');
    assert.strictEqual(off.revertIn, null, 'lockdown OFF is never turned back on');
    await sleep(1200); assert.strictEqual(sentReq.length, before + 1);
    await assert.rejects(eng.command({ kind: 'outputzone', target: Z, value: 'activate' }, 't'), /zones under test/);
    eng.saveSettings({ cloud: { zones: [Z] } });
    await eng.command({ kind: 'maintenance', target: DOOR, value: true, revertSec: 60 }, 'tester');
    assert.strictEqual(eng.pendingReverts().length, 1);
    const eng2 = new TraceEngine(); eng2.cloud.command = eng.cloud.command;
    assert.strictEqual(eng2.pendingReverts()[0].kind, 'maintenance', 'turn-back kept on disk');
    // normally-closed DPS pulses off then on; a failing "back" step is retried and reported
    eng.saveWiring({ 'relay:6': { role: 'dps', door: DOOR, active: 'closed' } });
    q.calls = [];
    eng.saveSettings({ sync: { channel: { kind: 'relay', relay: 6 }, gapsMs: [300, 300] } });
    const nc = await eng.sendSync('check');
    assert.deepStrictEqual(q.calls, [['setRelay', 6, false], ['setRelay', 6, true]]);
    assert.deepStrictEqual(nc.map(x => x.types[0]), ['open', 'closed']);
    let fails = 2; q.calls = [];
    const orig = q.enqueue; q.enqueue = async function (op, ch, v) { if (v === true && fails-- > 0) throw new Error('i2c busy'); return orig.call(this, op, ch, v); };
    await eng.sendSync('check');
    assert.deepStrictEqual(q.calls.at(-1), ['setRelay', 6, true], 'put back after two failures');
    fails = 9;
    await assert.rejects(eng.sendSync('check'), /could not put relay:6 back/);
    q.enqueue = orig;
    // a damaged Log Analytics settings file is never overwritten by a wiring save
    fs.writeFileSync(ap, '{ "thresholds": {"latencyWarnMs": 1');
    assert.throws(() => eng.saveWiring({}), /damaged/);
    ok('commands: off by default, scoped (doors, areas, zones), sent with the session, logged with who; only "on" commands turned back, kept across restarts; wiring shared and never clobbers a damaged file; pulse sync honours NC DPS and always releases');
  }

  console.log('TRACE-3: Doors page pairing');
  {
    const { doorChannels, channelOfActivity, readerChannels } = require('../trace/doors');
    const OD = '33333333-3333-3333-3333-333333333333', OD2 = '55555555-5555-5555-5555-555555555555';
    const phys = { id: 1, name: 'Main Entrance', enabled: true, ioSource: 'physical', reader: 'wg-1',
      lock: { hardwareType: 'analog-in', channel: 7 }, dps: { hardwareType: 'relay', channel: 0, reverseSense: true }, rexIn: { hardwareType: 'relay', channel: 1 },
      ios: [{ id: 'sf1', name: 'Strike Follower', hardwareType: 'opto', channel: 5 }, { name: 'Sounder', hardwareType: 'relay', channel: 6 }],
      trace: { oncafeDoorId: OD, note: 'NC DPS on REL 1' } };
    const emu = { id: 2, name: 'Back Door', enabled: true, ioSource: 'emulated', emuBoard: 11, lock: { hardwareType: 'relay', channel: 0 }, dps: { channel: 2 }, rexIn: { channel: 3 } };
    const m = Object.fromEntries([...doorChannels(phys), ...doorChannels(emu)].map(x => [x.key, x.entry]));
    assert.deepStrictEqual(Object.keys(m).sort(), ['door:1:dps', 'door:1:io:Sounder', 'door:1:io:sf1', 'door:1:lock', 'door:1:rex', 'door:2:dps', 'door:2:lock', 'door:2:rex', 'emu:11:in:2', 'emu:11:in:3', 'emu:11:out:0', 'opto:5', 'relay:0', 'relay:1', 'relay:6'].sort());
    assert.strictEqual(m['door:1:dps'].role, 'dps'); assert.strictEqual(m['door:1:dps'].door, OD); assert.strictEqual(m['door:1:dps'].note, 'NC DPS on REL 1');
    assert.strictEqual(m['door:1:lock'].role, 'lock'); assert.strictEqual(m['door:1:lock'].dir, 'out'); assert(/EOL watch/.test(m['door:1:lock'].label));
    assert.strictEqual(m['relay:0'].role, 'ignore'); assert.strictEqual(m['door:1:io:sf1'].role, 'output'); assert.strictEqual(m['door:1:io:Sounder'].role, 'input');
    assert.strictEqual(m['door:2:lock'].role, 'lock'); assert.strictEqual(m['emu:11:out:0'].role, 'ignore');
    assert.strictEqual(channelOfActivity('1:dps:relay:0'), 'door:1:dps'); assert.strictEqual(channelOfActivity('2:rexIn:emu:11:3'), 'door:2:rex');
    assert.strictEqual(channelOfActivity('1:io:sf1:opto:5'), 'door:1:io:sf1'); assert.strictEqual(channelOfActivity('1:lock:analog:7'), 'door:1:lock');
    assert.deepStrictEqual(readerChannels('ctrl-emu-11-0'), ['emu:11:rdr:0']);
    ok('door → channels: physical (analog EOL lock watch, NC DPS, custom I/O), emulated; raw wires marked "via door"; door activity keys');

    const { TraceEngine } = require('../trace/engine');
    const eng = new TraceEngine();
    const dc = path.join(__dirname, '..', 'data', 'doors', 'door-config.json');
    const ap = path.join(__dirname, '..', 'data', 'analytics', 'settings.json');
    fs.mkdirSync(path.dirname(dc), { recursive: true });
    fs.writeFileSync(ap, JSON.stringify({ thresholds: { latencyWarnMs: 99 }, wiring: { 'relay:9': { role: 'rex' }, 'relay:0': { role: 'dps' } } }));
    const savedAt = Date.now() - 5000;
    fs.writeFileSync(dc, JSON.stringify({ version: '3.0', savedAt: new Date(savedAt).toISOString(), doors: [phys, emu] }));
    const r1 = eng.importDoors();
    assert.strictEqual(r1.doors, 2);
    let w = eng.wiring();
    assert.strictEqual(w['relay:9'].role, 'rex', 'manual entries kept');
    assert.strictEqual(w['relay:0'].role, 'ignore', 'the door owns relay:0 now (last save wins)');
    assert.strictEqual(w['door:1:dps'].src, 'door:1'); assert.strictEqual(w['door:1:dps'].at, savedAt);
    assert.strictEqual(JSON.parse(fs.readFileSync(ap, 'utf8')).thresholds.latencyWarnMs, 99);
    // Event Trace edits the pairing → it goes back to the door
    w = JSON.parse(JSON.stringify(w));
    w['door:1:lock'].door = OD2; w['door:1:lock'].note = 'moved to the lab door'; w['door:1:dps'].active = 'closed';
    eng.saveWiring(w, 'event trace (tester)');
    const cfg = JSON.parse(fs.readFileSync(dc, 'utf8'));
    const d1 = cfg.doors.find(d => d.id === 1);
    assert.strictEqual(d1.trace.oncafeDoorId, OD2); assert.strictEqual(d1.trace.note, 'moved to the lab door'); assert.strictEqual(d1.trace.by, 'event trace (tester)');
    assert.strictEqual(d1.dps.reverseSense, false, 'DPS sense flipped on the door');
    w = eng.wiring();
    assert.strictEqual(w['door:1:dps'].door, OD2, 'every channel of the door follows'); assert.strictEqual(w['door:1:rex'].note, 'moved to the lab door');
    assert.strictEqual(w['door:1:dps'].active, 'open');
    ok('door save → wiring (manual entries kept, raw wires taken over); wiring save → door (OnCAFE door, description, DPS sense) for every channel of that door');
    // last save wins at start-up: an older door config does not overwrite newer edits; a newer one does
    w = JSON.parse(JSON.stringify(eng.wiring())); w['door:1:rex'].role = 'input';
    eng.saveWiring(w);
    const older = JSON.parse(fs.readFileSync(dc, 'utf8')); older.savedAt = new Date(Date.now() - 60000).toISOString(); fs.writeFileSync(dc, JSON.stringify(older));
    const e2 = new TraceEngine(); e2._importIfNewer();
    assert.strictEqual(e2.wiring()['door:1:rex'].role, 'input', 'older door config does not win');
    older.savedAt = new Date(Date.now() + 2000).toISOString(); fs.writeFileSync(dc, JSON.stringify(older));
    e2._importIfNewer();
    assert.strictEqual(e2.wiring()['door:1:rex'].role, 'rex', 'newer door config wins');
    ok('last save wins at start-up (door config vs wiring timestamps)');

    // door activity → traces: DPS from the door, strike watched on the analog zone, card on the door's reader
    const T = Date.now() - 60000;
    const live = new TraceEngine();
    live.saveSettings({ cloud: { doorConfig: { [OD2]: { grantMs: 5000 } } } });
    live.onDoorActivity({ t: T, doorId: 1, kind: 'dps', text: 'DPS OPEN · REL 1', source: 'aether' }, { key: '1:dps:relay:0', value: 1 });
    live.onDoorActivity({ t: T - 10, doorId: 1, kind: 'dps', text: 'x', source: 'aether' }, { key: '1:dps:relay:0', value: 1, initial: true });
    live.add(fromCloud({ eventTimestamp: T + 40, doorId: OD2, eventMeta: { eventId: 'o1', events: [{ event: [{ eventType: 'open' }] }] } }, { src: 'cloud-mqtt', at: T + 800 })[0]);
    live.add(fromJournal({ t: T + 10000, k: 'card', ch: 'wiegand:wg-1', v: 1, src: 'wiegand', m: { fc: 1, cn: 7 } }));
    live.add(fromCloud({ eventTimestamp: T + 10050, doorId: OD2, cardNumber: '7', facilityCode: '1', eventMeta: { eventId: 'g1', events: [{ event: [{ eventType: 'accessgranted' }] }] } }, { src: 'cloud-mqtt', at: T + 10700 })[0]);
    live.add(fromCloud({ eventTimestamp: T + 10060, doorId: OD2, eventMeta: { eventId: 'u1', events: [{ event: [{ eventType: 'unlocked' }] }] } }, { src: 'cloud-mqtt', at: T + 10750 })[0]);
    live.onDoorActivity({ t: T + 10300, doorId: 1, kind: 'lock', text: 'Lock UNLOCKED by panel · ADC 8', source: 'panel' }, { key: '1:lock:analog:7', value: 1 });
    live.onDoorActivity({ t: T + 15300, doorId: 1, kind: 'lock', text: 'Lock relocked · ADC 8', source: 'panel' }, { key: '1:lock:analog:7', value: 0 });
    live.onDoorActivity({ t: T + 16000, doorId: 1, kind: 'lock', text: 'Lock zone TROUBLE', source: 'panel' }, { key: '1:lock:analog:7', value: 'TROUBLE' });
    const a = live.analyze(null);
    const dps = a.traces.find(t => t.kind === 'input' && t.action.ch === 'door:1:dps');
    assert(dps && dps.result === 'open', JSON.stringify(dps && dps.notes));
    const strike = a.traces.find(t => t.kind === 'output' && t.action.ch === 'door:1:lock' && t.action.v === 1);
    assert(strike.cause && /card 1-7 granted/.test(strike.cause.label), 'analog strike traced back to the card');
    const off = a.traces.find(t => t.kind === 'output' && t.action.ch === 'door:1:lock' && t.action.v === 0);
    assert.strictEqual(off.held, 5000);
    assert(live.live.some(e => e.type === 'door-fault'));
    const sum = live.doorsSummary();
    const s1 = sum.doors.find(d => d.id === 1);
    assert.strictEqual(s1.oncafe.id, OD2); assert.strictEqual(s1.last.card.label, '1-7'); assert.strictEqual(s1.last.output.held, 5000); assert.strictEqual(s1.grantMs, 5000);
    assert.strictEqual(s1.last.input.result, 'open');
    ok('door activity (incl. analog EOL strike) → input/output traces; per-door summary for the Doors page');
  }

  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
