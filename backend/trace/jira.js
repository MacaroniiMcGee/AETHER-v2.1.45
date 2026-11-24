// trace/jira.js — Jira Cloud round trip for Event Trace.   AETHER_TRACE (TRACE-5)
//
//   - list a ticket's .har attachments and pull one into a run (the Pi downloads it; nothing goes through the browser)
//   - attach a run's results to a ticket (traces CSV, test CSV, a JSON summary) and optionally comment a short summary
// Login: the Atlassian site (e.g. hanwhavision.atlassian.net), an e-mail and an API token
// (id.atlassian.com › Security › API tokens). Kept on the Pi in backend/data/trace/jira.json (mode 600), never sent back
// to the browser. Requests go only to https://<site>.atlassian.net; attachment downloads follow Atlassian's redirect to
// its media host without the login.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const FILE = path.join(__dirname, '..', 'data', 'trace', 'jira.json');
const MAX_DOWNLOAD = 60 * 1024 * 1024;
const err = (message, status = 400) => Object.assign(new Error(message), { status });
const KEY = /^[A-Z][A-Z0-9_]{0,30}-\d{1,9}$/;
const SITE = /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/;
// tests only: AETHER_TRACE_JIRA_TEST=http://127.0.0.1:<port> sends every request to a local mock instead
const testBase = () => process.env.AETHER_TRACE_JIRA_TEST || '';

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } }
function save(c) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function status() { const c = load(); return { site: c.site || '', email: c.email || '', hasToken: !!c.token, configured: !!(c.site && c.email && c.token) }; }
function configure(b = {}) {
  const c = load();
  if (b.site !== undefined) {
    const site = String(b.site || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (site && !SITE.test(site)) throw err('The Jira site must be <name>.atlassian.net');
    c.site = site;
  }
  if (b.email !== undefined) { const e = String(b.email || '').trim(); if (e && !/^[^\s@]+@[^\s@]+$/.test(e)) throw err('That is not an e-mail address'); c.email = e; }
  if (b.token !== undefined && b.token !== null) c.token = String(b.token).trim().slice(0, 400);   // '' removes it
  save(c);
  return status();
}

// where Jira may send a download: its own sites and Atlassian's media service, never anything else (no LAN addresses)
const REDIRECT_OK = h => /^[a-z0-9-]+\.atlassian\.net$/i.test(h) || /^api\.media\.atlassian\.com$/i.test(h) || /\.media\.atlassian\.com$/i.test(h);
function request(method, p, { body, headers = {}, raw = false, url, hops = 0 } = {}) {
  const c = load();
  if (!url && !(c.site && c.email && c.token)) throw err('Set up Jira first (Setup › Jira: site, e-mail and API token)', 400);
  const target = new URL(url || (testBase() ? testBase() + p : `https://${c.site}${p}`));
  const own = !url;   // the login only ever goes to the Jira site itself
  const lib = target.protocol === 'http:' ? http : https;
  const h = { Accept: 'application/json', ...headers };
  if (own) h.Authorization = 'Basic ' + Buffer.from(`${c.email}:${c.token}`).toString('base64');
  if (body && !Buffer.isBuffer(body) && typeof body !== 'string') { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  if (body) h['Content-Length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const rq = lib.request(target, { method, headers: h, timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && method === 'GET') {
        res.resume();
        const next = new URL(res.headers.location, target);
        if (hops >= 5) return reject(err('Jira redirected too many times'));
        if (!testBase() && (next.protocol !== 'https:' || !REDIRECT_OK(next.hostname))) return reject(err(`Jira redirected to ${next.protocol}//${next.hostname}, which is not an Atlassian address`));
        // back to the Jira site itself: the login goes along again; anywhere else (the media host) it does not
        const home = c.site && next.hostname.toLowerCase() === c.site.toLowerCase();
        return resolve(home ? request('GET', next.pathname + next.search, { raw, hops: hops + 1 }) : request('GET', null, { raw, url: next.toString(), hops: hops + 1 }));
      }
      const chunks = []; let n = 0;
      res.on('data', d => { n += d.length; if (n > MAX_DOWNLOAD) { rq.destroy(); reject(err('Over 60 MB', 413)); return; } chunks.push(d); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          let msg = `Jira answered HTTP ${res.statusCode}`;
          try { const j = JSON.parse(buf.toString('utf8')); msg += ': ' + ((j.errorMessages || []).concat(Object.values(j.errors || {})).join('; ') || j.message || ''); } catch { /* */ }
          if (res.statusCode === 401) msg = 'Jira refused the login (check the e-mail and API token in Setup › Jira)';
          if (res.statusCode === 404) msg = 'Jira: not found (check the issue key, and that this account can see it)';
          return reject(err(msg, res.statusCode === 401 || res.statusCode === 403 ? 403 : res.statusCode === 404 ? 404 : 502));
        }
        if (raw) return resolve(buf);
        try { resolve(buf.length ? JSON.parse(buf.toString('utf8')) : {}); } catch { resolve({}); }
      });
    });
    rq.on('timeout', () => rq.destroy(err('Jira did not answer within 30 s', 504)));
    rq.on('error', e => reject(e.status ? e : err(`Could not reach Jira: ${e.message}`, 502)));
    if (body) rq.write(body);
    rq.end();
  });
}

function checkKey(k) { const key = String(k || '').trim().toUpperCase(); if (!KEY.test(key)) throw err('That is not a Jira issue key (e.g. OCF-7412)'); return key; }

async function whoAmI() { const j = await request('GET', '/rest/api/3/myself'); return { name: j.displayName || j.emailAddress || '?', accountId: j.accountId || null }; }

async function issue(k) {
  const key = checkKey(k);
  const j = await request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,attachment,status`);
  const f = j.fields || {};
  const att = (f.attachment || []).map(a => ({ id: String(a.id), filename: a.filename, size: a.size, created: a.created, author: a.author && a.author.displayName, mimeType: a.mimeType }));
  return { key, summary: f.summary || '', status: f.status && f.status.name, attachments: att, hars: att.filter(a => /\.har$/i.test(a.filename || '') || /har\+json/i.test(a.mimeType || '')) };
}

async function download(id) {
  if (!/^\d{1,15}$/.test(String(id))) throw err('Bad attachment id');
  return request('GET', `/rest/api/3/attachment/content/${id}`, { raw: true });
}

/** Attach files: [{ name, data (Buffer|string), type }] */
async function attach(k, files) {
  const key = checkKey(k);
  const boundary = '----AetherTrace' + Date.now().toString(36);
  const parts = [];
  for (const f of files) {
    const name = String(f.name).replace(/["\r\n]/g, '_');
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${f.type || 'application/octet-stream'}\r\n\r\n`));
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data)));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const r = await request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Atlassian-Token': 'no-check' } });
  return (Array.isArray(r) ? r : []).map(a => ({ id: String(a.id), filename: a.filename, size: a.size }));
}

/** A plain comment (Atlassian document format: one paragraph per line). */
async function comment(k, text) {
  const key = checkKey(k);
  const content = String(text).split('\n').slice(0, 60).map(l => (l.trim() ? { type: 'paragraph', content: [{ type: 'text', text: l.slice(0, 1000) }] } : { type: 'paragraph', content: [] }));
  return request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: { body: { type: 'doc', version: 1, content } } });
}

module.exports = { status, configure, whoAmI, issue, download, attach, comment, checkKey, _redirectOk: REDIRECT_OK };
