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
    assert.strictEqual(m['relay:0'].role, 'dps'); assert.strictEqual(m['relay:0'].via, 'door:1:dps'); assert.strictEqual(m['relay:0'].active, 'closed', 'raw NC wire keeps its polarity');
    assert.strictEqual(m['door:1:io:sf1'].role, 'output'); assert.strictEqual(m['door:1:io:Sounder'].role, 'input');
    assert.strictEqual(m['door:2:lock'].role, 'lock'); assert.strictEqual(m['emu:11:out:0'].role, 'lock'); assert.strictEqual(m['emu:11:out:0'].via, 'door:2:lock');
    assert.deepStrictEqual(doorChannels(null), []);
    assert.strictEqual(channelOfActivity('1:dps:relay:0'), 'door:1:dps'); assert.strictEqual(channelOfActivity('2:rexIn:emu:11:3'), 'door:2:rex');
    assert.strictEqual(channelOfActivity('1:io:sf1:opto:5'), 'door:1:io:sf1'); assert.strictEqual(channelOfActivity('1:lock:analog:7'), 'door:1:lock');
    assert.deepStrictEqual(readerChannels('ctrl-emu-11-0'), ['emu:11:rdr:0']);
    ok('door → channels: physical (analog EOL lock watch, NC DPS, custom I/O), emulated; raw wires keep their role and point at the door; door activity keys');

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
    assert.strictEqual(w['relay:0'].via, 'door:1:dps', 'the door owns relay:0 now (last save wins)'); assert.strictEqual(w['relay:0'].was.role, 'dps', 'the manual mapping is remembered');
    assert.strictEqual(w['door:1:dps'].src, 'door:1'); assert.strictEqual(w['door:1:dps'].at, savedAt);
    assert.strictEqual(JSON.parse(fs.readFileSync(ap, 'utf8')).thresholds.latencyWarnMs, 99);
    // Event Trace edits the pairing → it goes back to the door
    w = JSON.parse(JSON.stringify(w));
    w['door:1:lock'].door = OD2; w['door:1:lock'].note = 'moved to the lab door'; w['door:1:dps'].active = 'closed';
    eng.saveWiring(w, 'event trace (tester)', Math.max(...Object.values(w).map(e => e.at || 0)));
    const cfg = JSON.parse(fs.readFileSync(dc, 'utf8'));
    const d1 = cfg.doors.find(d => d.id === 1);
    assert.strictEqual(d1.trace.oncafeDoorId, OD2); assert.strictEqual(d1.trace.note, 'moved to the lab door'); assert.strictEqual(d1.trace.by, 'event trace (tester)');
    assert.strictEqual(d1.dps.reverseSense, false, 'DPS sense flipped on the door');
    w = eng.wiring();
    assert.strictEqual(w['door:1:dps'].door, OD2, 'every channel of the door follows'); assert.strictEqual(w['door:1:rex'].note, 'moved to the lab door');
    assert.strictEqual(w['door:1:dps'].active, 'open'); assert.strictEqual(w['relay:0'].active, 'open', 'the raw wire follows the new sense'); assert.strictEqual(d1.trace.dpsSense, false);
    ok('door save → wiring (manual entries kept, raw wires taken over); wiring save → door (OnCAFE door, description, DPS sense) for every channel of that door');
    // last save wins at start-up: an older door config does not overwrite newer edits; a newer one does
    w = JSON.parse(JSON.stringify(eng.wiring())); w['door:1:rex'].note = 'edited in trace';
    eng.saveWiring(w);
    const older = JSON.parse(fs.readFileSync(dc, 'utf8')); older.savedAt = new Date(Date.now() - 60000).toISOString(); older.doors[0].trace.note = 'old door note'; fs.writeFileSync(dc, JSON.stringify(older));
    const e2 = new TraceEngine(); e2._importIfNewer();
    assert.strictEqual(e2.wiring()['door:1:rex'].note, 'edited in trace', 'older door config does not win');
    older.savedAt = new Date(Date.now() + 2000).toISOString(); fs.writeFileSync(dc, JSON.stringify(older));
    e2._importIfNewer();
    assert.strictEqual(e2.wiring()['door:1:rex'].note, 'old door note', 'newer door config wins');
    const again = fs.readFileSync(ap, 'utf8'); e2._importIfNewer();
    assert.strictEqual(fs.readFileSync(ap, 'utf8'), again, 'no re-import once imported');
    ok('last save wins at start-up (door config vs wiring timestamps)');

    // review fixes: stale tabs, overrides, manual mappings, Doors page merge, deletes, pulse sync on a door wire
    {
      const keepDc = fs.readFileSync(dc, 'utf8'), keepAp = fs.readFileSync(ap, 'utf8');
      const fresh = () => { fs.writeFileSync(ap, JSON.stringify({ wiring: { 'relay:3': { role: 'input', label: 'manual bell' } } })); fs.writeFileSync(dc, JSON.stringify({ savedAt: new Date(Date.now() - 9000).toISOString(), doors: [JSON.parse(JSON.stringify(phys))] })); };
      fresh();
      const e3 = new TraceEngine(); e3.importDoors();
      const stale = JSON.parse(JSON.stringify(e3.wiring())); const staleBase = Math.max(...Object.values(stale).map(e => e.at || 0));
      const cfg2 = JSON.parse(fs.readFileSync(dc, 'utf8')); cfg2.doors[0].trace.note = 'newer from the door'; cfg2.savedAt = new Date().toISOString(); fs.writeFileSync(dc, JSON.stringify(cfg2));
      e3.importDoors();
      stale['door:1:dps'].note = 'stale tab';
      assert.throws(() => e3.saveWiring(stale, 'x', staleBase), e => e.status === 409 || /changed since you opened/.test(e.message));
      assert.strictEqual(e3.wiring()['door:1:dps'].note, 'newer from the door');
      // an override survives door saves until reset
      const partial = e3.saveWiring({ 'relay:3': e3.wiring()['relay:3'], 'relay:9': { role: 'rex' } });
      assert.strictEqual(partial['door:1:dps'].role, 'dps', 'a partial save keeps door entries as they are'); assert(!partial['door:1:dps'].pin);
      let cur = JSON.parse(JSON.stringify(e3.wiring())); cur['door:1:rex'].role = 'input'; cur['door:1:io:Sounder'].role = 'ignore';
      e3.saveWiring(cur, 'x', Math.max(...Object.values(cur).map(e => e.at || 0)));
      e3.importDoors();
      cur = e3.wiring();
      assert.strictEqual(cur['door:1:rex'].role, 'input'); assert(cur['door:1:rex'].pin);
      assert.strictEqual(cur['door:1:io:Sounder'].role, 'ignore', 'removed door entry stays off');
      assert(e3.doorsSummary().doors[0].channels.find(c => c.key === 'door:1:rex').overridden);
      cur = JSON.parse(JSON.stringify(cur)); cur['door:1:rex'] = { ...cur['door:1:rex'], reset: true };
      e3.saveWiring(cur, 'x', Math.max(...Object.values(cur).map(e => e.at || 0)));
      assert.strictEqual(e3.wiring()['door:1:rex'].role, 'rex'); assert(!e3.wiring()['door:1:rex'].pin);
      // a door takes relay:3 over, then lets go: the manual mapping comes back
      const cfg3 = JSON.parse(fs.readFileSync(dc, 'utf8')); cfg3.doors[0].rexIn = { hardwareType: 'relay', channel: 3 }; cfg3.savedAt = new Date().toISOString(); fs.writeFileSync(dc, JSON.stringify(cfg3));
      e3.importDoors(); assert.strictEqual(e3.wiring()['relay:3'].via, 'door:1:rex');
      cfg3.doors[0].rexIn = { hardwareType: 'relay', channel: 1 }; fs.writeFileSync(dc, JSON.stringify(cfg3));
      e3.importDoors(); assert.deepStrictEqual({ role: e3.wiring()['relay:3'].role, label: e3.wiring()['relay:3'].label, src: e3.wiring()['relay:3'].src }, { role: 'input', label: 'manual bell', src: undefined });
      // a stale Doors page posting an older pairing keeps the newer one (and the DPS sense Event Trace set)
      cur = JSON.parse(JSON.stringify(e3.wiring())); cur['door:1:dps'].door = OD2; cur['door:1:dps'].active = 'closed';
      const oldPage = JSON.parse(fs.readFileSync(dc, 'utf8'));
      e3.saveWiring(cur, 'event trace (t)', Math.max(...Object.values(cur).map(e => e.at || 0)));
      oldPage.doors[0].name = 'Renamed on the page';
      assert.strictEqual(e3.mergeDoorSave(oldPage), 1);
      assert.strictEqual(oldPage.doors[0].trace.oncafeDoorId, OD2); assert.strictEqual(oldPage.doors[0].dps.reverseSense, false); assert.strictEqual(oldPage.doors[0].name, 'Renamed on the page');
      const mine = JSON.parse(JSON.stringify(oldPage)); mine.doors[0].trace = { ...mine.doors[0].trace, oncafeDoorId: OD, updatedAt: new Date(Date.now() + 1000).toISOString(), by: 'doors page' };
      assert.strictEqual(e3.mergeDoorSave(mine), 0, 'a newer edit on the Doors page wins');
      // pulse sync works on a relay a door owns (role and NC polarity from the wire)
      e3.saveSettings({ sync: { mode: 'pulse', channel: { kind: 'relay', relay: 0 } } });
      const pz = e3._pulseSync(); assert.strictEqual(pz.ch, 'relay:0'); assert.strictEqual(pz.rest, e3.wiring()['relay:0'].active === 'closed' ? 1 : 0);
      // config deleted: door entries go
      fs.unlinkSync(dc); e3.importDoors();
      assert(!Object.keys(e3.wiring()).some(k => /^door:/.test(k))); assert.strictEqual(e3.wiring()['relay:3'].label, 'manual bell');
      // correlate: a door wire is traced through the door while the door reports, as itself otherwise
      const { correlate: corr } = require('../trace/correlate');
      const wv = { 'relay:0': { role: 'dps', via: 'door:1:dps' }, 'door:1:dps': { role: 'dps', src: 'door:1' } };
      const T0 = Date.now() - 30000;
      const both = [fromJournal({ t: T0, k: 'relay', ch: 'relay:0', v: 1 }), { ...fromJournal({ t: T0 + 5, k: 'relay', ch: 'door:1:dps', v: 1 }), type: 'door-in', journal: { ch: 'door:1:dps', v: 1, k: 'door-in' } }];
      assert.strictEqual(corr(both, [], {}, { wiring: wv }).roles['relay:0'].role, 'ignore');
      assert.strictEqual(corr([both[0]], [], {}, { wiring: wv }).roles['relay:0'].role, 'dps');
      fs.writeFileSync(dc, keepDc); fs.writeFileSync(ap, keepAp);
    }
    ok('review: stale Setup tab refused (409); overrides kept until reset; partial saves keep doors; door rows switched off stay off; manual mappings restored; stale Doors page keeps newer pairing; deleted config; pulse sync on a door wire; door wires traced once');

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

  console.log('TRACE-4: test sequences, integrity, compare, alerts');
  {
    const { cleanSequence, template, grade } = require('../trace/tests');
    const { integrity } = require('../trace/integrity');
    const { compare } = require('../trace/compare');
    // sequences are cleaned, templates expand to steps
    const sq = cleanSequence({ name: 'x', steps: [{ kind: 'card', door: '1', fc: '55', cn: '10a01', expect: { result: 'grant', strike: 'on' } }, { kind: 'bogus' }, { kind: 'rex', door: 1, holdMs: 5 }], repeat: 0 });
    assert.strictEqual(sq.steps[0].cn, '1001'); assert.strictEqual(sq.steps[0].door, 1); assert.strictEqual(sq.steps[1].kind, 'wait'); assert.strictEqual(sq.steps[2].holdMs, 100); assert.strictEqual(sq.repeat, 1);
    for (const k of ['valid', 'invalid', 'rex', 'forced', 'held', 'apb', 'lockdown', 'override', 'firstcard', 'schedule', 'elevator']) assert(template(k, 1, { fc: 1, cn: 2 }).length, k);
    assert.strictEqual(template('held', 1, { fc: 1, cn: 2 }, { heldMs: 10000 })[2].expect.withinMs, 25000);
    ok('sequences cleaned (bad steps, limits); 11 door behaviour templates');

    // integrity: lost push, duplicates, out of order, only in the controller log
    const E = (src, type, t, at, id, extra = {}) => ({ id: 'e' + Math.random(), src, lane: src === 'controller' ? 'controller' : 'cloud', type, t, at, eventId: id, door: { id: 'D', name: 'Door' }, controllerId: 'C', ...extra });
    const now = Date.now();
    const ie = [E('cloud-mqtt', 'accessgranted', now - 60000, now - 59000, 'a'), E('cloud-api', 'accessgranted', now - 60000, now - 58000, 'a'),
      E('cloud-api', 'accessdenied', now - 50000, now - 48000, 'b'),                       // never pushed
      E('cloud-mqtt', 'open', now - 40000, now - 39000, 'c'), E('cloud-mqtt', 'open', now - 40000, now - 38000, 'c'), E('cloud-api', 'open', now - 40000, now - 37000, 'c'),   // pushed twice
      E('cloud-mqtt', 'closed', now - 45000, now - 36000, 'd'), E('cloud-api', 'closed', now - 45000, now - 35000, 'd'),      // stamped before 'open' but pushed after it
      E('controller', 'rexactivated', now - 30000, null, null)];                             // only in the controller log
    const ig = integrity(ie, { pollMs: 1000, apiEnabled: true, now });
    assert.strictEqual(ig.lostInPush.length, 1); assert.strictEqual(ig.lostInPush[0].type, 'accessdenied');
    assert.strictEqual(ig.duplicates.length, 1); assert.strictEqual(ig.duplicates[0].copies, 2);
    assert.strictEqual(ig.outOfOrder.length, 1); assert.strictEqual(ig.outOfOrder[0].type, 'closed');
    assert.strictEqual(ig.onlyInLog.length, 1); assert.strictEqual(ig.verdict, 'fail');
    assert.strictEqual(integrity([E('cloud-mqtt', 'open', now, now - 100, 'z')], { pollMs: 2000, apiEnabled: true, now }).notInLog.length, 0, 'a fresh push is not yet missing from the event log');
    ok('integrity: lost in push, duplicate pushes, out of order, only in the controller log; a fresh push is given time');

    // compare: the noise rule and new / fixed failures
    const st = (p50, p95) => ({ n: 10, p50, p95, max: p95 });
    const K = (d, p) => ({ actions: 10, pass: 9, warn: 0, fail: 1, decision: st(d, d * 2), push: st(p, p * 2), api: { n: 0 }, decisionToPush: { n: 0 }, output: { n: 0 }, hardware: { n: 0 }, ack: { n: 0 }, verdict: 'fail' });
    const an = (d, p, fails) => ({ meta: { id: 'r', name: 'r', start: 1 }, clock: { offset: 0, drift: null }, stats: { ...K(d, p), byKind: { card: K(d, p), input: K(0, 0), output: K(0, 0), command: K(0, 0) } },
      traces: fails.map((l, i) => ({ id: 't' + i, kind: 'card', at: i, sync: false, status: 'fail', action: { label: l }, expect: 'grant', notes: ['x'], decision: null })), integrity: null });
    const cmp = compare(an(300, 900, ['card 1-1']), an(330, 2200, ['card 1-2']), [], [], null, null);
    const dec = cmp.hops.find(h => h.kind === 'card' && h.hop === 'decision'), push = cmp.hops.find(h => h.kind === 'card' && h.hop === 'push');
    assert.strictEqual(dec.p50, 'same', '+30 ms is noise'); assert.strictEqual(push.p50, 'worse'); assert.strictEqual(push.p95, 'worse');
    assert.strictEqual(cmp.newFail.length, 1); assert.strictEqual(cmp.fixed.length, 1);
    ok('compare: changes count only past 25 % and 100 ms; new and fixed failures');

    // run a sequence end to end on a Doors page door (relays + Wiegand), with a fake controller and cloud
    const { TraceEngine } = require('../trace/engine');
    const dc = path.join(__dirname, '..', 'data', 'doors', 'door-config.json');
    const ap = path.join(__dirname, '..', 'data', 'analytics', 'settings.json');
    const keepDc = fs.existsSync(dc) ? fs.readFileSync(dc, 'utf8') : null, keepAp = fs.existsSync(ap) ? fs.readFileSync(ap, 'utf8') : null;
    const OD = '77777777-7777-7777-7777-777777777777';
    fs.mkdirSync(path.dirname(dc), { recursive: true });
    fs.writeFileSync(dc, JSON.stringify({ savedAt: new Date().toISOString(), doors: [{ id: 1, name: 'Lab door', enabled: true, ioSource: 'physical', reader: 'wg-1',
      dps: { hardwareType: 'relay', channel: 0 }, rexIn: { hardwareType: 'relay', channel: 1 }, lock: { hardwareType: 'opto-in', channel: 3 }, trace: { oncafeDoorId: OD } }] }));
    fs.writeFileSync(ap, JSON.stringify({ wiring: {} }));
    const eng = new TraceEngine();
    eng.importDoors();
    const cloudEv = (type, extra = {}, lag = 150) => setTimeout(() => eng.add(fromCloud({ eventTimestamp: Date.now() - lag + 20, doorId: OD, ...extra, eventMeta: { eventId: Math.random().toString(16).slice(2), events: [{ event: [{ eventType: type }] }] } }, { src: 'cloud-mqtt', at: Date.now() })[0]), lag);
    let granted = false;
    const wm = { getReaders: () => [{ id: 'wg-1' }], async sendCard(id, fc, cn) {
      eng.add(fromJournal({ t: Date.now(), k: 'card', ch: `wiegand:${id}`, v: 1, src: 'wiegand', m: { fc, cn } }));
      if (cn === 1001) { granted = true; cloudEv('accessgranted', { cardNumber: '1001', facilityCode: String(fc) });
        setTimeout(() => eng.add(fromJournal({ t: Date.now(), k: 'opto', ch: 'opto:3', v: 1, src: 'physical' })), 220);
        setTimeout(() => { eng.add(fromJournal({ t: Date.now(), k: 'opto', ch: 'opto:3', v: 0, src: 'physical' })); granted = false; }, 1500); cloudEv('unlocked', {}, 200); cloudEv('locked', {}, 1480); }
      else cloudEv('accessdenied', { cardNumber: String(cn), facilityCode: String(fc) });
      return { success: true }; } };
    const writes = [];
    const gq = { async enqueue(op, ch, v) { writes.push([op, ch, v]); eng.add(fromJournal({ t: Date.now(), k: 'relay', ch: `relay:${ch}`, v: v ? 1 : 0, src: 'physical' }));
      if (ch === 0) cloudEv(v ? (granted ? 'open' : 'doorforcedopen') : 'closed'); if (ch === 1) cloudEv(v ? 'rexactivated' : 'rexdeactivated'); return { success: true }; } };
    eng.deps = { getWiegand: () => wm, gpioQueue: gq };
    eng.saveSettings({ sync: { atStart: false, atEnd: false }, thresholds: { pushFail: 2000, pushWarn: 1500 } });
    const seqDef = eng.saveSequence({ name: 'Lab door basics', sync: false, steps: [
      ...template('valid', 1, { fc: 55, cn: 1001 }).map(x => ({ ...x, afterMs: 2200, expect: { ...x.expect, withinMs: 3000 } })),
      ...template('invalid', 1, { fc: 55 }, { badCn: 9 }).map(x => ({ ...x, afterMs: 800 })),
      ...template('rex', 1).map(x => ({ ...x, afterMs: 600 })),
      { kind: 'dps', door: 1, state: 'open', label: 'Forced', expect: { events: ['doorforcedopen'] }, afterMs: 400 },
      { kind: 'dps', door: 1, state: 'close', afterMs: 400 },
      { kind: 'card', door: 1, fc: 55, cn: 9, label: 'Should be granted (it is not)', expect: { result: 'grant' }, afterMs: 800 },
    ] });
    const st0 = await eng.runTest(seqDef.id, { repeat: 2, gapMs: 200 }, 'tester').catch(e => { throw e; });
    if (st0.state !== 'running' && eng.test.state !== 'done') throw new Error('test did not start');
    for (let i = 0; i < 900 && eng.test.state !== 'done'; i++) await sleep(100);
    assert.strictEqual(eng.test.state, 'done', 'test finished');
    const rep = eng.testReport(eng.test.runId);
    const by = Object.fromEntries(rep.report.byStep.map(x => [x.idx, x]));
    assert.strictEqual(rep.iterations, 2);
    assert.strictEqual(by[0].pass + by[0].warn, 2, 'valid card graded: ' + JSON.stringify(rep.report.steps.filter(x => x.idx === 0).map(x => x.why)));
    assert.strictEqual(by[1].pass + by[1].warn, 2, 'denied card: ' + JSON.stringify(rep.report.steps.filter(x => x.idx === 1).map(x => x.why)));
    assert.strictEqual(by[2].pass + by[2].warn, 2, 'REX: ' + JSON.stringify(rep.report.steps.filter(x => x.idx === 2).map(x => x.why)));
    assert.strictEqual(by[3].pass + by[3].warn, 2, 'forced: ' + JSON.stringify(rep.report.steps.filter(x => x.idx === 3).map(x => x.why)));
    assert.strictEqual(by[5].fail, 2, 'a wrong expectation fails');
    assert(rep.report.steps.find(x => x.idx === 0).latency.output != null, 'strike latency measured');
    assert.strictEqual(rep.report.totals.verdict, 'fail');
    assert(writes.some(w => w[1] === 1 && w[2] === false), 'REX released'); assert.deepStrictEqual(writes.filter(w => w[1] === 0).slice(-1)[0].slice(1), [0, false], 'DPS left closed');
    assert(rep.report.series.length >= 4);
    ok('test run: valid / denied card, REX, forced open graded pass over 2 repeats; a wrong expectation fails; strike latency; DPS / REX put back');

    // stopping mid-test releases what it moved; a test cannot start while one runs; commands need Commands on
    const long = eng.saveSequence({ name: 'Hold', sync: false, steps: [{ kind: 'dps', door: 1, state: 'open', afterMs: 100 }, { kind: 'wait', ms: 60000 }] });
    await eng.runTest(long.id, {}, 't');
    await assert.rejects(eng.runTest(long.id, {}, 't'), /already running/);
    await sleep(500); eng.stopTest();
    for (let i = 0; i < 900 && eng.test.state !== 'done'; i++) await sleep(100);
    assert.strictEqual(eng.test.state, 'done'); assert.deepStrictEqual(writes.slice(-1)[0].slice(1), [0, false], 'DPS closed again after stop');
    eng.saveSettings({ commands: { enabled: false } });
    const cmdSeq = eng.saveSequence({ name: 'Cmd', steps: template('lockdown', 1, { fc: 1, cn: 2 }) });
    await assert.rejects(eng.runTest(cmdSeq.id, {}, 't'), /Commands on/);
    ok('stop: the test halts and puts the DPS back; one test at a time; command steps need Setup › Commands');

    // live alerts: a failed trace raises one alert once
    const seen = [];
    eng.on('alert', x => seen.push(x));
    eng.run = null; eng.live = [];
    eng.cloud.status = () => ({ push: { state: 'connected' }, api: {} });
    const T0 = Date.now() - 40000;
    eng.add(fromJournal({ t: T0, k: 'card', ch: 'wiegand:wg-1', v: 1, src: 'wiegand', m: { fc: 3, cn: 3 } }));
    eng.settings.expectations = [];
    eng._caches = {}; eng._alertLast = 0; eng._alertTick(); eng._caches = {}; eng._alertLast = 0; eng._alertTick();
    assert.strictEqual(seen.length, 1); assert.strictEqual(seen[0].status, 'fail'); assert(eng.alertsSince(0).alerts.length >= 1);
    ok('live alerts: a failed trace raises one alert (once), kept for the page');
    // review (harness): a trace judged during a run is not raised again when the run ends and the live view takes over
    const before = seen.length;
    eng._alerted.clear(); eng._alerted.add(eng.live.find(e => e.src === 'journal' && e.type === 'card').id);
    eng._caches = {}; eng._alertLast = 0; eng._alertTick();
    assert.strictEqual(seen.length, before, 'judged once');
    // review (harness): sync cards whose decisions arrive without card numbers are never matched to door events
    {
      const S0 = Date.now() - 120000;
      const evs = [
        fromJournal({ t: S0, k: 'card', ch: 'wiegand:wg-1', v: 1, src: 'wiegand', m: { fc: 123, cn: 1234 } }),
        fromJournal({ t: S0 + 2000, k: 'card', ch: 'wiegand:wg-1', v: 1, src: 'wiegand', m: { fc: 123, cn: 9876 } }),
        ...fromCloud({ eventTimestamp: S0 + 5000 + 1240, doorId: OD, eventMeta: { eventId: 'x1', events: [{ event: [{ eventType: 'open' }] }] } }, { src: 'cloud-mqtt', at: S0 + 5300 }),
        ...fromCloud({ eventTimestamp: S0 + 7000 + 1240, doorId: OD, eventMeta: { eventId: 'x2', events: [{ event: [{ eventType: 'closed' }] }] } }, { src: 'cloud-mqtt', at: S0 + 7300 }),
      ];
      const syncs = [{ at: S0, fc: 123, cn: '1234', set: 'start', idx: 0, batch: 'b' }, { at: S0 + 2000, fc: 123, cn: '9876', set: 'start', idx: 1, batch: 'b' }];
      const r = correlate(evs, syncs, { thresholds: {}, expectations: [] }, { wiring: {} });
      assert.strictEqual(r.clock.offset, null, 'door open / closed 2 s apart are not taken for the sync pair');
    }
    ok('review: alerts judged once (no repeat when the live view takes over); sync pairs never matched to door events');
    // review: an "on" command a test sent is turned back when the test stops early; a restart releases what a test left engaged
    {
      const sent = [], cmds = [];
      eng.saveSettings({ commands: { enabled: true }, cloud: { doors: [OD] } });
      eng.command = async c => { cmds.push(c); return { ok: true, status: 200, event: 'ev' + cmds.length }; };
      eng._send = async cmd => { sent.push(cmd); return { r: { ok: true }, e: { id: 'x' } }; };
      const mseq = eng.saveSequence({ name: 'Maint', sync: false, steps: [{ kind: 'command', door: 1, cmd: 'maintenance', value: true, afterMs: 100 }, { kind: 'wait', ms: 60000 }, { kind: 'command', door: 1, cmd: 'maintenance', value: false }] });
      await eng.runTest(mseq.id, {}, 't');
      await sleep(600); eng.stopTest();
      for (let i = 0; i < 900 && eng.test.state !== 'done'; i++) await sleep(100);
      assert.strictEqual(cmds[0].revertSec, 600, 'backstop turn-back on the "on" command');
      assert(sent.some(c => c.kind === 'maintenance' && c.value === false), 'maintenance turned back when the test stopped');
      delete eng.command; delete eng._send;
      eng.saveSettings({ commands: { enabled: false } });
      // restart: a DPS a test had opened is closed by the next engine
      fs.writeFileSync(path.join(__dirname, '..', 'data', 'trace', 'test-touched.json'), JSON.stringify([{ k: '1:dps', door: 1 }]));
      const e2 = new TraceEngine(); e2.deps = { gpioQueue: gq };
      writes.length = 0;
      await e2._releaseOrphans();
      assert.deepStrictEqual(writes[0], ['setRelay', 0, false], 'DPS released after a restart');
      assert(!fs.existsSync(path.join(__dirname, '..', 'data', 'trace', 'test-touched.json')));
      // a REX release that fails once is retried inside the step
      let failOnce = true;
      const gq2 = { async enqueue(op, ch, v) { if (ch === 1 && !v && failOnce) { failOnce = false; throw new Error('Rate limit exceeded'); } writes.push([op, ch, v]); return { success: true }; } };
      eng.deps = { getWiegand: () => wm, gpioQueue: gq2 };
      const rseq = eng.saveSequence({ name: 'Rex', sync: false, steps: [{ kind: 'rex', door: 1, holdMs: 100, afterMs: 100 }] });
      writes.length = 0;
      await eng.runTest(rseq.id, {}, 't');
      for (let i = 0; i < 400 && eng.test.state !== 'done'; i++) await sleep(100);
      assert.deepStrictEqual(writes.filter(w => w[1] === 1).map(w => w[2]), [true, false], 'REX released after one failed try');
      eng.deps = { getWiegand: () => wm, gpioQueue: gq };
    }
    // review: a missing event in one repeat is not covered by the next repeat's event
    {
      const tA = Date.now() - 100000;
      const steps = [cleanSequence({ steps: [{ kind: 'dps', door: 1, state: 'open', expect: { events: ['doorforcedopen'] } }] }).steps[0]];
      const log = [{ iter: 1, idx: 0, kind: 'dps', at: tA, end: tA, door: 1, oncafe: OD }, { iter: 2, idx: 0, kind: 'dps', at: tA + 8000, end: tA + 8000, door: 1, oncafe: OD }];
      const evs = [{ id: 'f2', src: 'cloud-mqtt', lane: 'cloud', type: 'doorforcedopen', t: tA + 8100, at: tA + 8600, eventId: 'k2', door: { id: OD } }];
      const g = grade({ clock: { offset: 0 }, traces: [] }, evs, log, steps, { pushFail: 10000 });
      assert.deepStrictEqual(g.steps.map(x => x.status), ['fail', 'pass']);
    }
    // review: integrity stays linear on a long run
    {
      const big = [];
      for (let i = 0; i < 15000; i++) { big.push({ src: 'cloud-mqtt', lane: 'cloud', type: 'open', t: i * 10, at: i * 10 + 500, eventId: 'p' + i, door: { id: 'D' } }); big.push({ src: 'cloud-api', lane: 'cloud', type: 'open', t: i * 10, at: i * 10 + 900, eventId: 'p' + i, door: { id: 'D' } }); }
      const t0 = Date.now(); const r = integrity(big, { pollMs: 1000, apiEnabled: true, now: Date.now() }); const ms = Date.now() - t0;
      assert.strictEqual(r.issues, 0); assert(ms < 1500, `integrity on 30k events took ${ms} ms`);
    }
    ok('review: test "on" commands turned back on stop (+10 min backstop); restart releases a DPS a test left open; REX release retried; one event answers one repeat; integrity linear');
    if (keepDc != null) fs.writeFileSync(dc, keepDc); else fs.unlinkSync(dc);
    if (keepAp != null) fs.writeFileSync(ap, keepAp);
  }

  console.log('TRACE-5: reader feedback, controller clocks, Jira, wiring suggestion');
  {
    const { frameToEvent } = require('../trace/readerfeedback');
    const { readDate, parseUtc } = require('../trace/clockcheck');
    const { suggestWiring } = require('../trace/suggest');
    // reader LED after a grant: a hop on the card trace; red after a grant is a warning
    const T0 = Date.now() - 300000;
    const led = c => Buffer.from([0, 0, 2, 5, 5, c, c, 20, 0, 1, 0, 0, 1, 1]).toString('hex');
    const evs = [
      fromJournal({ t: T0, k: 'card', ch: 'osdp:rd1', v: 1, src: 'osdp', m: { fc: 5, cn: 77 } }),
      ...fromCloud({ eventTimestamp: T0 + 120, doorId: 'D1', cardNumber: '77', facilityCode: '5', eventMeta: { eventId: 'a1', events: [{ event: [{ eventType: 'accessgranted' }] }] } }, { src: 'cloud-mqtt', at: T0 + 900 }),
      frameToEvent({ name: 'osdp_LED', isReply: false, address: 1, port: 'p', dataHex: led(2), ts: T0 + 180 }, [{ id: 'rd1', address: 1 }]),
      frameToEvent({ name: 'osdp_BUZ', isReply: false, address: 1, port: 'p', dataHex: '0002010101', ts: T0 + 185 }, [{ id: 'rd1', address: 1 }]),
      fromJournal({ t: T0 + 10000, k: 'card', ch: 'osdp:rd1', v: 1, src: 'osdp', m: { fc: 5, cn: 77 } }),
      ...fromCloud({ eventTimestamp: T0 + 10100, doorId: 'D1', cardNumber: '77', facilityCode: '5', eventMeta: { eventId: 'a2', events: [{ event: [{ eventType: 'accessgranted' }] }] } }, { src: 'cloud-mqtt', at: T0 + 10800 }),
      frameToEvent({ name: 'osdp_LED', isReply: false, address: 1, port: 'p', dataHex: led(1), ts: T0 + 10200 }, [{ id: 'rd1', address: 1 }]),
    ];
    assert.strictEqual(frameToEvent({ name: 'osdp_LED', isReply: false, address: 3, port: '/dev/ttyUSB1', dataHex: led(1), ts: T0 }, [], { emuPorts: ['/dev/ttyUSB1'] }).info.ch, 'emu:3:rdr:0', 'controller emulator on a serial port');
    assert.strictEqual(frameToEvent({ name: 'osdp_LED', isReply: false, address: 1, port: 'p', dataHex: led(1), ts: T0, encrypted: true }, [{ id: 'rd1', address: 1 }]), null, 'secure channel: ciphertext is not read as a colour');
    assert.strictEqual(frameToEvent({ name: 'osdp_LED', isReply: false, address: 1, port: 'p', dataHex: led(1), ts: T0, checkOk: false }, [{ id: 'rd1', address: 1 }]), null, 'bad checksum ignored');
    const r = correlate(evs, [], { thresholds: {}, expectations: [] }, { wiring: {} });
    const c1 = r.traces.find(t => t.at === T0), c2 = r.traces.find(t => t.at === T0 + 10000);
    assert.strictEqual(c1.latency.reader, 180); assert.strictEqual(c1.reader.colour, 'green'); assert.strictEqual(c1.reader.beep, 'beep');
    assert(c1.hops.some(h => h.id === 'reader')); assert(c2.notes.some(n => /showed red for a grant/.test(n)));
    assert.strictEqual(r.stats.reader.n, 2);
    ok('reader LED / buzzer: last hop of a card trace (time, colour, beep); wrong colour warns');

    // controller clock from a SUNAPI date view
    assert.strictEqual(parseUtc('2026-11-23 20:01:02'), Date.UTC(2026, 10, 23, 20, 1, 2));
    assert.strictEqual(parseUtc('2026-11-23T20:01:02-05:00'), Date.UTC(2026, 10, 24, 1, 1, 2));
    const dv = readDate(JSON.stringify({ Date: { UTCTime: '2026-11-23T20:01:02Z', LocalTime: '2026-11-23T15:01:02', TimeZone: 'EST5EDT', SyncType: 'NTP', NTPServer: 'pool.ntp.org' } }));
    assert.strictEqual(dv.utc, Date.UTC(2026, 10, 23, 20, 1, 2)); assert.strictEqual(dv.sync, 'NTP'); assert.strictEqual(dv.ntp, 'pool.ntp.org');
    assert.strictEqual(readDate('UTCTime=2026-11-23 20:01:02\nSyncType=Manual').sync, 'Manual');
    ok('controller clock: SUNAPI date view (JSON or key=value, UTC / offset forms, NTP)');

    // Jira: list HARs, download through a redirect (login not forwarded), attach, comment — against a mock
    {
      const jira = require('../trace/jira');
      const seenReq = [];
      const harText = JSON.stringify({ log: { entries: [] } });
      const srv = http.createServer((q, s2) => {
        let body = []; q.on('data', d => body.push(d)); q.on('end', () => {
          seenReq.push({ m: q.method, u: q.url, auth: q.headers.authorization || null, ct: q.headers['content-type'] || '', tok: q.headers['x-atlassian-token'] || null, body: Buffer.concat(body).toString('utf8') });
          if (q.url.startsWith('/rest/api/3/issue/OCF-7412?')) return s2.end(JSON.stringify({ fields: { summary: 'Door event late', status: { name: 'Open' }, attachment: [{ id: '101', filename: 'lobby.har', size: 10 }, { id: '102', filename: 'notes.txt', size: 3 }] } }));
          if (q.url === '/rest/api/3/attachment/content/101') { s2.writeHead(302, { Location: `http://127.0.0.1:${srv.address().port}/media/101` }); return s2.end(); }
          if (q.url === '/media/101') return s2.end(harText);
          if (q.url === '/loop') { s2.writeHead(302, { Location: '/loop' }); return s2.end(); }
          if (q.url === '/rest/api/3/attachment/content/103') { s2.writeHead(302, { Location: '/loop' }); return s2.end(); }
          if (q.url.endsWith('/attachments')) return s2.end(JSON.stringify([{ id: '900', filename: 'x.csv', size: 5 }]));
          if (q.url.endsWith('/comment')) return s2.end('{}');
          if (q.url === '/rest/api/3/myself') return s2.end(JSON.stringify({ displayName: 'QA Tester' }));
          s2.statusCode = 404; s2.end('{}');
        });
      });
      await new Promise(res => srv.listen(0, '127.0.0.1', res));
      process.env.AETHER_TRACE_JIRA_TEST = `http://127.0.0.1:${srv.address().port}`;
      jira.configure({ site: 'hanwhavision.atlassian.net', email: 'qa@x.com', token: 'tok-123' });
      assert.deepStrictEqual(jira.status(), { site: 'hanwhavision.atlassian.net', email: 'qa@x.com', hasToken: true, configured: true });
      assert.strictEqual((fs.statSync(path.join(__dirname, '..', 'data', 'trace', 'jira.json')).mode & 0o777), 0o600);
      assert.throws(() => jira.configure({ site: 'evil.example.com' }), /atlassian\.net/);
      const iss = await jira.issue('ocf-7412');
      assert.strictEqual(iss.key, 'OCF-7412'); assert.deepStrictEqual(iss.hars.map(h => h.id), ['101']);
      const buf = await jira.download('101');
      assert.strictEqual(buf.toString('utf8'), harText);
      const media = seenReq.find(x => x.u === '/media/101');
      assert.strictEqual(media.auth, null, 'the login is not sent to the media host');
      assert(seenReq.find(x => x.u === '/rest/api/3/attachment/content/101').auth.startsWith('Basic '));
      const att = await jira.attach('OCF-7412', [{ name: 'a.csv', data: 'x,y\n', type: 'text/csv' }]);
      assert.strictEqual(att[0].id, '900');
      const up = seenReq.find(x => x.u.endsWith('/attachments'));
      assert(/multipart\/form-data; boundary=/.test(up.ct)); assert.strictEqual(up.tok, 'no-check'); assert(/filename="a.csv"/.test(up.body));
      await jira.comment('OCF-7412', 'line 1\nline 2');
      assert.strictEqual(JSON.parse(seenReq.find(x => x.u.endsWith('/comment')).body).body.content.length, 2);
      await assert.rejects(jira.issue('not a key'), /not a Jira issue key/);
      await assert.rejects(jira.download('103'), /too many times/);
      assert(jira._redirectOk('api.media.atlassian.com') && jira._redirectOk('hanwhavision.atlassian.net') && !jira._redirectOk('10.0.0.1') && !jira._redirectOk('atlassian.net.evil.com'));
      srv.close(); delete process.env.AETHER_TRACE_JIRA_TEST;
    }
    ok('Jira: HARs of a ticket, download through the media redirect without the login, attachments (multipart), comment; token file mode 600; site must be *.atlassian.net');

    // suggestion: probe beats the Doors page beats what was seen; differences from the wiring map flagged
    const sg = suggestWiring({
      doors: [{ id: 1, name: 'Main', oncafe: 'D1', raw: { dps: 'relay:0', rex: 'relay:1', lock: 'opto:2' }, reader: 'wg-1', readerChannels: ['wiegand:wg-1'], dpsNc: false }],
      wiring: { 'relay:0': { role: 'dps', door: 'D1', active: 'open' } },
      seen: [{ ch: 'relay:5', count: 12, inferred: { role: 'rex', door: 'D2', score: 0.8 } }, { ch: 'relay:1', count: 4, inferred: { role: 'input', door: 'D1', score: 0.6 } }],
      probe: { at: 1, relays: [{ ch: 'relay:0', role: 'dps', door: 'D1', active: 'closed', events: [{ type: 'closed' }] }], readers: [{ ch: 'wiegand:wg-1', door: 'D1', type: 'accessgranted' }], locks: [{ door: 'D1', ch: 'opto:2', ms: 140 }] },
      inventory: { doors: [{ id: 'D1', name: 'Lobby', controllerId: 'C' }, { id: 'D2', name: 'Dock', controllerId: 'C' }], controllers: [{ id: 'C', name: 'Lab NHP', model: 'NHP-P200' }] },
    });
    const row = ch => sg.rows.find(x => x.ch === ch);
    assert.strictEqual(row('relay:0').source, 'probe'); assert.strictEqual(row('relay:0').active, 'closed'); assert.strictEqual(row('relay:0').differs, true, 'NC proven, map says NO');
    assert.strictEqual(row('relay:1').source, 'doors page'); assert.strictEqual(row('relay:1').role, 'rex');
    assert.strictEqual(row('relay:5').source, 'seen');
    assert.strictEqual(row('opto:2').source, 'probe');
    const lobby = sg.controllers[0].doors.find(d => d.door === 'D1');
    assert.strictEqual(sg.controllers[0].model, 'NHP-P200'); assert.strictEqual(lobby.reader.ch, 'wiegand:wg-1'); assert.strictEqual(lobby.dps.terminal.label, 'REL1'); assert.strictEqual(lobby.lock.terminal.label, 'OPTO3');
    ok('wiring suggestion: probe > Doors page > seen; per controller door (reader, DPS, REX, lock) for the drawing; differences flagged');

    // Discover: a relay pulse proves a DPS (NC from the reply), a card proves a reader, then the result feeds the suggestion
    {
      const { TraceEngine } = require('../trace/engine');
      const e = new TraceEngine();
      const writes = []; let failedOnce = false;
      const cloud = (type, door, extra = {}) => setTimeout(() => e.add(fromCloud({ eventTimestamp: Date.now(), doorId: door, doorName: door === 'D1' ? 'Lobby' : 'Dock', ...extra, eventMeta: { eventId: Math.random().toString(16).slice(2), events: [{ event: [{ eventType: type }] }] } }, { src: 'cloud-mqtt', at: Date.now() })[0]), 150);
      e.deps = {
        gpioQueue: { async enqueue(op, ch, v) { if (op === 'getRelay') return { state: ch === 3 ? 1 : 0 }; writes.push([ch, v]); if (ch === 2 && v === false && !failedOnce) { failedOnce = true; throw new Error('i2c busy'); } if (ch === 2) cloud(v ? 'closed' : 'open', 'D1'); if (ch === 3) { cloud(v ? 'rexactivated' : 'rexdeactivated', 'D2'); if (v) cloud('open', 'D1'); } return {}; } },
        getWiegand: () => ({ getReaders: () => [{ id: 'wg-9', name: 'Wiegand 9' }], async sendCard() { cloud('accessdenied', 'D2', { cardNumber: '1234' }); } }),
      };
      e.cloud.status = () => ({ push: { state: 'connected' }, api: {} });
      await e.discover({ relays: [2, 3], holdMs: 500, watchMs: 2000, locks: false }, 'tester');
      for (let i = 0; i < 100 && e.discovering.state !== 'done'; i++) await sleep(100);
      const d = e.discoverStatus();
      const r2 = d.relays.find(x => x.ch === 'relay:2'), r3 = d.relays.find(x => x.ch === 'relay:3');
      assert.strictEqual(r2.role, 'dps'); assert.strictEqual(r2.door, 'D1'); assert.strictEqual(r2.active, 'closed', 'relay on → closed: a normally-closed contact');
      assert.strictEqual(r3.role, 'rex', 'another door opening meanwhile does not win'); assert.strictEqual(r3.door, 'D2');
      assert.strictEqual(d.readers[0].door, 'D2');
      assert.deepStrictEqual(writes, [[2, true], [2, false], [2, false], [3, false], [3, true]], 'every relay toggled away from its real state and back (a failed put-back is retried)');
      assert(!fs.existsSync(path.join(__dirname, '..', 'data', 'trace', 'discover-touched.json')), 'nothing left marked as switched');
      await assert.rejects(e.discover({}, 't').then(() => e.discover({}, 't')), /already running/);
      e.stopDiscover(); for (let i = 0; i < 100 && e.discovering.state !== 'done'; i++) await sleep(100);
      const s2 = e.suggest();
      assert(s2.rows.some(x => x.ch === 'relay:2' && x.source === 'probe'));
    }
    // a restart while Discover had a relay switched: it is put back at start
    {
      const { TraceEngine } = require('../trace/engine');
      fs.writeFileSync(path.join(__dirname, '..', 'data', 'trace', 'discover-touched.json'), JSON.stringify({ ch: 5, rest: 1, at: Date.now() }));
      const e2 = new TraceEngine(); const w2 = [];
      e2.deps = { gpioQueue: { async enqueue(op, ch, v) { w2.push([op, ch, v]); return {}; } } };
      await e2._releaseDiscoverOrphan();
      assert.deepStrictEqual(w2, [['setRelay', 5, true]]); assert(!fs.existsSync(path.join(__dirname, '..', 'data', 'trace', 'discover-touched.json')));
    }
    ok('Discover: relay pulses prove DPS (and NC) / REX and their doors (other doors\' traffic meanwhile ignored), a card proves a reader; always toggled back to the relay\'s real state (retried, and after a restart); one at a time; feeds the suggestion');
  }

  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
