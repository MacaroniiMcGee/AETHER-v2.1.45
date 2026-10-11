// routes-oncafe.js - Board Blueprints: sign in to OnCafe from the Pi and read a site, no console script needed.
//
//   app.use('/api/oncafe', require('./routes-oncafe')());
//
// The browser can't call the OnCafe APIs from Aether's page (cross-site), but the Pi can. It signs in to the
// OnCafe Keycloak realm with the user's username and password (password grant, client acs-web-app), keeps only the
// refresh token (48 h) on the Pi, and reads the same data the Blueprint connector script reads.
// The password is used for that one sign-in request and is never stored or logged. Tokens never leave the Pi.
//
//   GET  /api/oncafe/session?url=<OnCafe address>   -> { signedIn, user, orgs, org, expiresAt }
//   POST /api/oncafe/signin  { url, username, password } -> same as /session
//   POST /api/oncafe/read    { url, org? }              -> { success, site }   (site = blueprint-site payload)
//   POST /api/oncafe/signout { url }

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLIENT_ID = 'acs-web-app';
const REALM = 'hva';
const STORE = path.join(__dirname, 'data', 'oncafe-session.json');
const TIMEOUT_MS = 30000;

// OnCafe address -> app, Keycloak and API hosts. Only *.oncafe.hanwhavision.cloud is accepted, so credentials
// can never be sent anywhere else.
function hosts(appUrl) {
  let host = '';
  try { host = new URL(String(appUrl || '').trim()).host.toLowerCase(); } catch (e) { return null; }
  const m = host.match(/^([a-z0-9-]+\.)?oncafe\.hanwhavision\.cloud$/);
  if (!m) return null;
  const env = m[1] || '';
  return {
    key: host,
    app: 'https://' + host,
    auth: `https://auth.${env}platform.hanwhavision.cloud/realms/${REALM}/protocol/openid-connect`,
    io: `https://api.${env}oncafe.hanwhavision.cloud/acsio/orgs`,
    device: `https://api.${env}platform.hanwhavision.cloud/device/orgs`,
    partner: `https://api.${env}platform.hanwhavision.cloud/partner`,
  };
}

// ---------------------------------------------------------------- session store (refresh token only, file mode 600)
let store = {};
try { store = JSON.parse(fs.readFileSync(STORE, 'utf8')) || {}; } catch (e) { store = {}; }
const access = {}; // host -> { token, exp }   (memory only)
function save() {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.chmodSync(STORE, 0o600);
  } catch (e) { console.warn('[OnCafe] could not save session:', e.message); }
}

class OnCafeError extends Error {
  constructor(message, status = 400, code = '') { super(message); this.status = status; this.code = code; }
}

async function http(url, opts = {}) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const why = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    throw new OnCafeError(`The Pi couldn't reach ${new URL(url).host} (${why}). Check the Pi's internet connection.`, 502, 'network');
  }
}

async function tokenRequest(H, form) {
  const r = await http(H.auth + '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...form }).toString(),
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* not JSON */ }
  if (r.ok && j.access_token) return j;
  const err = j.error || ('HTTP ' + r.status), desc = j.error_description || '';
  if (err === 'invalid_grant' && form.grant_type === 'password') {
    throw new OnCafeError(/disabled|locked/i.test(desc) ? `OnCafe refused the sign-in: ${desc}.` : 'Wrong username or password.', 401, 'credentials');
  }
  if (err === 'invalid_grant') throw new OnCafeError('The OnCafe sign-in has expired. Sign in again.', 401, 'expired');
  if (err === 'unauthorized_client') throw new OnCafeError('This OnCafe server does not allow sign-in from Aether. Use the connector script below instead.', 403, 'not_allowed');
  if (err === 'invalid_client') throw new OnCafeError('OnCafe did not recognise the Aether sign-in client. Use the connector script below instead.', 403, 'not_allowed');
  if (/resolve_required_actions|required action/i.test(err + desc)) throw new OnCafeError('OnCafe wants you to finish setting up this account (for example a new password or MFA). Sign in once in the browser, then try again.', 403, 'action_required');
  throw new OnCafeError(`OnCafe sign-in failed: ${desc || err}.`, r.status >= 500 ? 502 : 400, 'auth');
}

function keep(H, tok, extra = {}) {
  const now = Date.now();
  access[H.key] = { token: tok.access_token, exp: now + (Number(tok.expires_in) || 300) * 1000 };
  store[H.key] = {
    ...(store[H.key] || {}), ...extra,
    refresh: tok.refresh_token || (store[H.key] || {}).refresh,
    refreshExp: tok.refresh_expires_in ? now + Number(tok.refresh_expires_in) * 1000 : (store[H.key] || {}).refreshExp,
    at: new Date(now).toISOString(),
  };
  save();
}

// A valid access token for this host, refreshing it when it is within 2 minutes of expiry.
async function bearer(H) {
  const a = access[H.key];
  if (a && a.exp - Date.now() > 120000) return a.token;
  const s = store[H.key];
  if (!s || !s.refresh || (s.refreshExp && s.refreshExp < Date.now())) {
    throw new OnCafeError('Not signed in to OnCafe (or the 48-hour sign-in ran out). Sign in again.', 401, 'signed_out');
  }
  try {
    const tok = await tokenRequest(H, { grant_type: 'refresh_token', refresh_token: s.refresh });
    keep(H, tok);
    return tok.access_token;
  } catch (e) {
    if (e.status === 401) { delete store[H.key]; delete access[H.key]; save(); }
    throw e;
  }
}

async function api(H, url, tries = 0) {
  const r = await http(url, {
    headers: {
      authorization: 'Bearer ' + await bearer(H),
      accept: 'application/json',
      'x-app-id': 'acs',
      'x-tenant-id': REALM,
      'x-correlation-id': crypto.randomUUID(),
    },
  });
  if ((r.status === 429 || r.status >= 500) && tries < 3) {
    await new Promise(res => setTimeout(res, 800 * (tries + 1)));
    return api(H, url, tries + 1);
  }
  if (r.status === 401 && tries < 1) { delete access[H.key]; return api(H, url, tries + 1); }
  if (r.status === 401) throw new OnCafeError('OnCafe rejected the sign-in. Sign in again.', 401, 'signed_out');
  if (r.status === 403) throw new OnCafeError('This OnCafe account is not allowed to read ' + new URL(url).pathname.split('/').slice(0, 5).join('/') + '.', 403, 'forbidden');
  if (!r.ok) throw new OnCafeError(`OnCafe answered HTTP ${r.status} for ${new URL(url).pathname}.`, 502, 'api');
  const j = await r.json();
  return j && j.data !== undefined ? j.data : j;
}
const list = (d, keys) => Array.isArray(d) ? d : (keys.map(k => d && d[k]).find(Array.isArray) || []);

async function loadOrgs(H) {
  const [self, orgs] = await Promise.all([
    api(H, H.partner + '/account/self/v3').catch(() => null),
    api(H, H.partner + '/orgs').catch(() => []),
  ]);
  const acct = (self && self.account) || {};
  const all = list(orgs, ['orgs', 'organizations']).map(o => ({ id: o.orgId || o.id, name: o.orgName || o.name || o.orgId }))
    .filter(o => o.id);
  return { orgs: all, org: acct.orgId && all.some(o => o.id === acct.orgId) ? acct.orgId : (all[0] || {}).id || acct.orgId || '',
    name: [acct.firstName, acct.lastName].filter(Boolean).join(' ') };
}

function status(H) {
  const s = store[H.key];
  const ok = !!(s && s.refresh && (!s.refreshExp || s.refreshExp > Date.now()));
  return ok
    ? { signedIn: true, host: H.key, user: s.user, name: s.name || '', orgs: s.orgs || [], org: s.org || '', expiresAt: s.refreshExp ? new Date(s.refreshExp).toISOString() : null }
    : { signedIn: false, host: H.key };
}

// The same read the Blueprint connector script does in the OnCafe tab, producing the same blueprint-site payload.
async function readSite(H, ORG) {
  const devices = list(await api(H, `${H.device}/${ORG}/devices`), ['devices']).map(d => ({
    deviceId: d.deviceId, deviceName: d.deviceName, model: d.modelNumber || d.model || d.deviceType, deviceType: d.deviceType, parentId: d.parentId,
    status: d.connectionStatus || d.deviceStatus || '', firmware: d.firmwareVersion || '', locationId: d.locationId || '', areaId: d.areaId || '',
    io: ['input', 'output', 'reader'].flatMap(kind => ((d.ioConfig || {})[kind] || []).map(p => {
      const m = p.iomapping || {};
      return { kind, label: p.ioConfigLabel || p.labelId, labelId: p.labelId,
        usedAs: m.ioName || '', objectType: m.objectType || '', objectId: m.objectId || '', objectConfig: m.objectConfig || '', supervised: p.supervised,
        resistance: p.resistanceLevel || '', contact: p.contactType || '', mode: p.mode || '', address: p.address, baud: p.baudRate, secureChannel: p.secureChannel };
    })),
  }));
  const skipped = [];
  const safe = async (u, keys) => { try { return list(await api(H, u), keys); } catch (e) { if (e.code === 'signed_out' || e.code === 'network') throw e; skipped.push(e.message); return []; } };
  const [doorsRaw, locs, elevRaw, zonesRaw] = await Promise.all([
    safe(`${H.io}/${ORG}/doors/v2?pageNumber=0&pageSize=1000`, ['doors']),
    safe(`${H.partner}/orgs/${ORG}/locations`, ['locations']),
    safe(`${H.io}/${ORG}/elevators`, []),
    safe(`${H.io}/${ORG}/zones`, []),
  ]);
  return {
    kind: 'blueprint-site', v: 1, org: ORG, source: H.key, via: 'aether', at: new Date().toISOString(),
    devices,
    doors: doorsRaw.map(x => ({ id: x.doorId || x.id, name: x.doorName || x.name || '', controllerId: x.controllerId || x.deviceId || '', locationId: x.locationId || '', areaId: x.areaId || '' })),
    locations: locs.map(l => ({ id: l.locationId || l.id, name: l.locationName || l.name || '', areas: (l.areas || []).map(a => ({ id: a.areaId || a.id, name: a.areaName || a.name || '' })) })),
    elevators: elevRaw.map(x => ({ id: x.elevatorId || x.id, name: x.name || x.elevatorName || '', floors: (x.floors || []).length, controllerId: x.controllerId || '' })),
    zones: zonesRaw.map(x => ({ id: x.zoneId || x.id, name: x.zoneName || x.name || '', type: x.zoneType || '' })),
    skipped,
  };
}

module.exports = function oncafeRoutes() {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const handle = fn => async (req, res) => {
    const H = hosts((req.body && req.body.url) || req.query.url);
    if (!H) return res.status(400).json({ success: false, error: 'Enter an OnCafe address ending in oncafe.hanwhavision.cloud.' });
    try { await fn(H, req, res); }
    catch (e) {
      if (!(e instanceof OnCafeError)) console.error('[OnCafe]', e);
      res.status(e.status || 500).json({ success: false, error: e instanceof OnCafeError ? e.message : 'Unexpected error: ' + e.message, code: e.code || 'error', ...status(H) });
    }
  };

  router.get('/session', handle(async (H, _req, res) => res.json({ success: true, ...status(H) })));

  router.post('/signin', handle(async (H, req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: 'Enter your OnCafe username and password.' });
    const tok = await tokenRequest(H, { grant_type: 'password', username: String(username).trim(), password: String(password), scope: 'openid' });
    delete access[H.key];
    keep(H, tok, { user: String(username).trim() });
    const o = await loadOrgs(H);
    store[H.key] = { ...store[H.key], orgs: o.orgs, org: o.org, name: o.name };
    save();
    console.log(`[OnCafe] signed in to ${H.key} as ${store[H.key].user} (${o.orgs.length} org${o.orgs.length === 1 ? '' : 's'})`);
    res.json({ success: true, ...status(H) });
  }));

  router.post('/read', handle(async (H, req, res) => {
    const s = store[H.key] || {};
    const org = String((req.body && req.body.org) || s.org || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(org)) throw new OnCafeError('Pick the organisation to read.', 400, 'org');
    if (s.org !== org) { store[H.key] = { ...s, org }; save(); }
    const site = await readSite(H, org);
    console.log(`[OnCafe] read ${H.key} org ${org}: ${site.devices.length} devices, ${site.doors.length} doors`);
    res.json({ success: true, site, ...status(H) });
  }));

  router.post('/signout', handle(async (H, _req, res) => {
    const s = store[H.key];
    if (s && s.refresh) {
      // best effort: end the Keycloak session too
      http(H.auth + '/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, refresh_token: s.refresh }).toString() }).catch(() => {});
    }
    delete store[H.key]; delete access[H.key]; save();
    res.json({ success: true, ...status(H) });
  }));

  return router;
};
module.exports.hosts = hosts;
