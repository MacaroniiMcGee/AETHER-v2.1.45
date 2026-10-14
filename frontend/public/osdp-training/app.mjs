// AETHER OSDP Academy — user interface.
// Plain ES module, no build step. Pages render into <main> with template strings;
// every dynamic value goes through esc(). Clicks, inputs and changes are handled by
// delegation through data-act / data-in attributes.

import { hx, hex, h2, bytes, crc, checksum, build, parse, decodeFields, summary, entryFor, CMD, REP, short,
  SPEC, EN, SCB_TYPES, BEHAVIORS, TIMING, capExplain, caps, enumText, pageRef, examplesFor } from './protocol.mjs?v=79db13d7';
import { analyze, toMs, SEVERITY_ORDER, ruleText, expectedReplies } from './analyzer.mjs?v=79db13d7';
import { lessons, quizzes, levels, mfgSteps } from './content.mjs?v=79db13d7';
import { simulatedSession, scenarios } from './scenarios.mjs?v=79db13d7';

const VERSION = '2.1';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const embedded = (() => { try { return window.parent !== window; } catch { return true; } })();
if (embedded) document.body.classList.add('embed');
else { const tools = document.querySelector('.tabsbar .tools'), top = document.querySelector('.topbar'); if (tools && top) top.insertBefore(tools, $('themeBtn')); }

// ── state ──────────────────────────────────────────────────────────────────
const qs = new URLSearchParams(location.search);
const S = {
  edition: qs.get('edition') === 'current' ? 'current' : 'recommended',
  page: ({ dictionary: 'reference' })[qs.get('page')] || qs.get('page') || 'overview',
  lesson: 0, byteAt: {}, bitValue: 0x05, bitMode: 'CTRL', quizLevel: 1, quizIndex: 0, quizPicked: null,
  search: '', hidePoll: false, onlyFlagged: false, addrFilter: 'all', listLimit: 400, sevFilter: 'problems',
  selected: 0, compare: [0, 1], replay: null, scenario: null, reveal: false, faultHex: '', mfgSchema: null,
  b: { address: 2, dir: 'c', code: 0x60, sequence: 1, crc: true, scb: 'none', payload: '' },
};
const progress = Object.assign({ lessons: [], answers: {}, scenarios: [] }, store.get('aether-osdp-academy', {}));
const saveProgress = () => { store.set('aether-osdp-academy', progress); renderProgress(); };

// capture model
let uidSeq = 0;
const C = { frames: [], source: 'Simulated session · generated training traffic', marks: new Set(), notes: {}, dropped: 0, coach: null, dirty: true };
const MAX_FRAMES = 10000;
function record(f, origin) {
  if (typeof f === 'string') f = { fullHex: f };
  const full = f.fullHex ?? f.FullHex ?? f.rawHex ?? f.hex ?? f.Hex ?? (typeof f.bytes === 'string' ? f.bytes : Array.isArray(f.bytes) ? hex(f.bytes) : '');
  return { uid: ++uidSeq, fullHex: String(full || ''), dataHex: f.dataHex || f.DataHex || '', ts: f.ts ?? f.timestamp ?? f.Timestamp ?? f.Time ?? '', port: f.port || f.portPath || '',
    origin: f.origin || origin, aether: f.aether || (f.summary || f.name ? { summary: f.summary, name: f.name, checkOk: f.checkOk, errors: f.errors } : null), note: f.note || '' };
}
function setFrames(list, source) {
  C.frames = list; C.source = source; C.marks.clear(); C.notes = {}; C.dropped = 0; C.dirty = true; S.selected = 0; S.compare = [0, Math.min(1, list.length - 1)]; S.listLimit = 400;
}
function pushFrames(list) {
  C.frames.push(...list);
  if (C.frames.length > MAX_FRAMES) {
    const cut = C.frames.length - MAX_FRAMES; C.frames.splice(0, cut); C.dropped += cut; S.selected = Math.max(0, S.selected - cut);
  }
  C.dirty = true;
}
const parsed = new WeakMap();
function P(f) { if (!parsed.has(f)) { let p = null; try { p = parse(f.fullHex); } catch (e) { p = null; } parsed.set(f, p); } return parsed.get(f); }
function coach() { if (C.dirty || !C.coach) { C.coach = analyze(C.frames); C.dirty = false; C.byIdx = new Map(); for (const x of C.coach.findings) if (x.idx != null) { if (!C.byIdx.has(x.idx)) C.byIdx.set(x.idx, []); C.byIdx.get(x.idx).push(x); } } return C.coach; }
setFrames(simulatedSession().map((f) => record(f, 'simulation')), 'Simulated session · generated training traffic');

// ── utilities ──────────────────────────────────────────────────────────────
function toast(s) { const t = $('toast'); t.textContent = s; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 3500); }
function download(name, data, type = 'application/json') {
  const u = URL.createObjectURL(new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type }));
  const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1500);
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy is blocked here — select the text and copy it'); } }
const notice = (html, kind = '') => `<div class="notice ${kind}"><div>${html}</div></div>`;
const head = (eyebrow, title, text, right = '') => `<div class="pagehead"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${text ? `<p>${text}</p>` : ''}</div>${right ? `<div class="row">${right}</div>` : ''}</div>`;
const sevBadge = (s) => `<span class="badge ${s === 'error' ? 'error' : s === 'warn' ? 'warn' : s === 'ok' ? 'ok' : 'info'}">${s === 'warn' ? 'check' : s}</span>`;
const rec = () => S.edition === 'recommended';
const fmtTime = (ms, base) => { if (ms == null || !Number.isFinite(ms)) return '—'; if (base != null && Number.isFinite(base)) return `+${((ms - base) / 1000).toFixed(3)}`; const d = new Date(ms); return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(11, 23); };

// ── shell ──────────────────────────────────────────────────────────────────
const PAGES = [
  ['overview', 'Launchpad'], ['lessons', 'Lessons'], ['builder', 'Packet builder'], ['captures', 'Capture classroom'],
  ['faults', 'Troubleshooting', true], ['bits', 'Bit bench'], ['quiz', 'Knowledge checks', true], ['manufacturer', 'Vendor lab'],
  ['reference', 'Spec reference'], ['integration', 'Aether integration'],
];
function navigate(p) {
  if (S.replay) { clearInterval(S.replay); S.replay = null; }
  S.page = PAGES.some((x) => x[0] === p) ? p : 'overview';
  history.replaceState(null, '', `?edition=${S.edition}${S.page !== 'overview' ? `&page=${S.page}` : ''}`);
  render(); window.scrollTo(0, 0); $('main').focus({ preventScroll: true });
}
function render() {
  if (!rec() && PAGES.find((x) => x[0] === S.page)?.[2]) S.page = 'overview';
  $('edition').value = S.edition;
  $('nav').innerHTML = PAGES.filter((x) => rec() || !x[2]).map(([id, label]) =>
    `<button class="tab" role="tab" data-act="nav" data-page="${id}" aria-selected="${S.page === id}">${label}${id === 'captures' ? `<span class="count">${C.frames.length > 999 ? Math.round(C.frames.length / 1000) + 'k' : C.frames.length}</span>` : ''}</button>`).join('');
  renderProgress(); renderLiveChip();
  (PAGE_RENDER[S.page] || overview)();
}
function renderProgress() {
  const total = lessons.length + quizzes.length + scenarios.length;
  const n = progress.lessons.length + Object.values(progress.answers).filter(Boolean).length + progress.scenarios.length;
  $('progress').innerHTML = `<span class="badge" title="Lessons reviewed, questions answered correctly and scenarios solved on this browser">${n}/${total} milestones</span>`;
}
function renderLiveChip() {
  const st = LIVE.status;
  const html = st === 'off' ? '' : `<span class="badge ${st === 'live' ? 'ok' : st === 'error' ? 'error' : 'warn'}"><span class="dot ${st === 'live' ? 'ok pulse' : st === 'error' ? 'error' : 'warn'}"></span>${st === 'live' ? `Live · ${LIVE.got}` : st === 'error' ? 'Live error' : st === 'polling' ? `Live (polling) · ${LIVE.got}` : 'Connecting…'}</span>`;
  $('liveChip').innerHTML = html; $('liveChipTop').innerHTML = '';
}
$('edition').onchange = (e) => { S.edition = e.target.value; navigate(S.page); };
$('themeBtn').onclick = () => {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t; try { localStorage.setItem('hv-theme', t); } catch { /* */ }
};

// event delegation
const ACT = {}, INP = {};
document.addEventListener('click', (e) => { const t = e.target.closest('[data-act]'); if (t && ACT[t.dataset.act]) { ACT[t.dataset.act](t, e); } });
document.addEventListener('input', (e) => { const t = e.target.closest('[data-in]'); if (t && INP[t.dataset.in]) INP[t.dataset.in](t, e); });
document.addEventListener('change', (e) => { const t = e.target.closest('[data-ch]'); if (t && INP[t.dataset.ch]) INP[t.dataset.ch](t, e); });
ACT.nav = (t) => navigate(t.dataset.page);
ACT.go = (t) => navigate(t.dataset.to);

// ── inspector ──────────────────────────────────────────────────────────────
function kindOf(f, p) {
  if (/^(SOM|ADDR|LEN|CTRL)/.test(f.name)) return 'k-head';
  if (f.name.startsWith('SCB')) return 'k-scb';
  if (f.name === 'CMD' || f.name === 'REPLY') return 'k-code';
  if (f.name === 'CIPHERTEXT') return 'k-cipher';
  if (f.name === 'MAC') return 'k-mac';
  if (/CRC|CHECKSUM/.test(f.name)) return p.ok ? 'k-check' : 'k-bad';
  return 'k-data';
}
const LEGEND = `<div class="legend"><span class="k-head"><i></i>Header</span><span class="k-scb"><i></i>Security block</span><span class="k-code"><i></i>Code</span><span class="k-data"><i></i>Data</span><span class="k-cipher"><i></i>Ciphertext</span><span class="k-mac"><i></i>MAC</span><span class="k-check"><i></i>Check bytes</span></div>`;
function explainByte(p, off) {
  const f = p.fields[Math.min(off, p.fields.length - 1)];
  if (!f) return '';
  const v = f.value; let m;
  switch (f.name) {
    case 'SOM': m = 'Start of message. Receivers resynchronise on this byte.'; break;
    case 'ADDR': m = `Bit 7 = ${v >> 7}: ${p.reply ? 'reply from' : 'command to'} the reader. Bits 0–6 = ${p.address}${p.address === 0x7f ? ' (broadcast/configuration address)' : ''}.`; break;
    case 'LEN low': case 'LEN high': m = `LEN = low + 256 × high = ${p.b[2]} + 256 × ${p.b[3]} = ${p.length}. Counts SOM through the last check byte${p.marked ? '; the leading FF mark is not counted' : ''}.`; break;
    case 'CTRL': m = `Bits 0–1: SQN ${p.sequence}. Bit 2: ${p.crcMode ? 'CRC-16 (2 check bytes)' : 'checksum (1 check byte)'}. Bit 3: ${p.sb.length ? 'security block follows' : 'no security block'}. Bits 4–7: ${v & 0xf0 ? 'SET — must be 0' : 'reserved, 0'}.`; break;
    case 'SCB LEN': m = `Security block length ${v}, counting this byte. The code starts at offset ${p.cmdOffset}.`; break;
    case 'SCB TYPE': m = `${enumText(EN.securityBlockType, v) || 'Undefined security block type'}.`; break;
    case 'SCB DATA': m = p.type <= 0x14 ? (p.type === 0x14 ? `RMAC_I status: ${v === 1 ? '0x01 accepted' : v === 0xff ? '0xFF rejected' : 'unexpected value'}.` : `Key select: ${v === 1 ? '0x01 = SCBK (site key)' : v === 0 ? '0x00 = SCBK-D (default install key)' : 'unexpected value'}.`) : 'Security block data.'; break;
    case 'CMD': case 'REPLY': m = `${p.entry[0]} — ${p.entry[1]}. The same number can mean different things in each direction (0x76, 0x80), so the ADDR reply bit decides.`; break;
    case 'MAC': m = 'Message authentication code (4 bytes). Checking it needs the session keys, so the Academy shows it but cannot verify it.'; break;
    case 'CIPHERTEXT': m = 'Encrypted DATA. Kept opaque — no plaintext is guessed.'; break;
    case 'CRC low': case 'CRC high': m = `CRC-16 over every earlier byte, low byte first. ${p.ok ? 'Matches.' : 'Does NOT match.'}`; break;
    case 'CHECKSUM': m = `Makes the sum of all bytes 0 modulo 256. ${p.ok ? 'Matches.' : 'Does NOT match.'}`; break;
    default: { const r = decodeFields(p).rows.find((x) => f.offset >= x.abs && f.offset < x.abs + x.size); m = r ? `${r.record ? `Record ${r.record} · ` : ''}${r.name}: ${r.value}${r.meaning ? ` — ${r.meaning}` : ''}` : 'DATA byte.'; }
  }
  return `<div class="explain"><div class="small muted">Offset ${f.offset} · ${esc(f.name)}</div><div class="big">${hx(v)} hex = ${v} decimal = ${v.toString(2).padStart(8, '0')} binary</div><div>${esc(m)}</div></div>`;
}
function inspectorHTML(p, key, frame) {
  const sel = S.byteAt[key] ?? 4;
  const d = decodeFields(p);
  const def = p.def;
  const aeth = frame?.aether;
  return `<div class="row between"><div class="row"><h3 style="margin:0">${esc(p.entry[0])}</h3><span class="mono muted">${h2(p.command)}</span>
    <span class="badge ${p.reply ? 'info' : ''}">${p.reply ? 'Reader → controller' : 'Controller → reader'}</span>
    <span class="badge">addr ${p.address} · SQN ${p.sequence}</span>${p.type != null ? `<span class="badge brand">${esc(enumText(EN.securityBlockType, p.type)?.split(' ')[0] || 'SCB')}</span>` : ''}</div>
    <span class="badge ${p.ok && !p.issues.length ? 'ok' : 'error'}">${p.b.length} bytes · ${p.ok ? (p.crcMode ? 'CRC ok' : 'checksum ok') : (p.crcMode ? 'CRC bad' : 'checksum bad')}</span></div>
    <p class="small" style="margin-top:6px">${esc(p.entry[1])}. ${esc(p.entry[2] || '')} ${def ? `<span class="muted">SIA OSDP 2.2.2 §${esc(String(def.section).split(',')[0])}, ${pageRef(def.page)}.</span>` : ''}</p>
    <div class="bytes" role="group" aria-label="Frame bytes">${p.fields.map((f) => `<button class="byte ${kindOf(f, p)}" data-act="byte" data-off="${f.offset}" aria-pressed="${f.offset === sel}" title="${esc(f.name)} · offset ${f.offset}">${hx(f.value)}<small>${esc(f.name)}</small></button>`).join('')}</div>
    ${LEGEND}
    <div data-explain>${explainByte(p, sel)}</div>
    ${p.issues.length ? notice(`<b>Integrity / structure</b><br>${p.issues.map(esc).join('<br>')}`, 'error') : ''}
    ${[...p.warnings, ...d.warnings].length ? notice(`<b>Rule checks</b><br>${[...p.warnings, ...d.warnings].map(esc).join('<br>')}`, 'warn') : ''}
    ${!p.issues.length && !p.warnings.length && !d.warnings.length ? notice(`${p.crcMode ? 'CRC' : 'Checksum'} and LEN match. ${p.authenticated ? 'The MAC is shown, not verified.' : 'That proves the bytes arrived intact, not who sent them.'}`, 'ok') : ''}
    ${aeth?.summary ? notice(`<b>Aether OSDP Trace says:</b> ${esc(aeth.summary)}${aeth.checkOk === false ? ' · flagged bad check bytes' : ''}`) : ''}
    ${frame?.note ? notice(esc(frame.note)) : ''}
    ${d.notes.length ? `<h4 style="margin-top:12px">In plain words</h4><ul class="small" style="margin:0 0 8px;padding-left:18px;color:var(--c2)">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <h4 style="margin-top:12px">Fields</h4>
    ${d.rows.length ? `<div class="tablewrap" style="max-height:340px"><table class="t"><thead><tr><th>DATA</th><th>Bytes</th><th>Field</th><th>Value</th><th>Meaning</th></tr></thead><tbody>${d.rows.map((r) => `<tr class="${sel >= r.abs && sel < r.abs + r.size ? 'hl' : ''}"><td class="k">+${r.off}</td><td class="v">${esc(r.hex)}</td><td>${r.record ? `<span class="muted">#${r.record}</span> ` : ''}${esc(r.name)}</td><td class="v">${esc(r.value)}</td><td class="small">${esc(r.meaning)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="small muted">${p.encrypted ? 'Encrypted — fields hidden.' : 'No DATA bytes.'}</p>`}`;
}
function mountInspector(el, p, key, frame) { if (!el) return; el.dataset.insp = key; el.innerHTML = inspectorHTML(p, key, frame); el._p = p; el._frame = frame; }
ACT.byte = (t) => {
  const box = t.closest('[data-insp]'); if (!box || !box._p) return;
  S.byteAt[box.dataset.insp] = +t.dataset.off;
  mountInspector(box, box._p, box.dataset.insp, box._frame);
};

// ── Launchpad ──────────────────────────────────────────────────────────────
function overview() {
  const lessonDone = progress.lessons.length, qDone = Object.values(progress.answers).filter(Boolean).length, scDone = progress.scenarios.length;
  $('main').innerHTML = `
  <section class="hero">
    <div class="row between"><div class="eyebrow">AETHER OSDP Academy · SIA OSDP 2.2.2</div><span class="badge brand">${rec() ? 'Field Academy' : 'Core Workshop'} · v${VERSION}</span></div>
    <h1>From raw bytes to confident support.</h1>
    <p>Hands-on OSDP training for implementation and support teams. Build a frame, take a capture apart, follow Aether’s live OSDP Trace and practise real troubleshooting — no protocol background needed.</p>
    <div class="row"><button class="btn primary lg" data-act="go" data-to="lessons">Start the lessons</button><button class="btn lg" data-act="go" data-to="builder">Build your first frame</button><button class="btn outline lg" data-act="go" data-to="captures">Open the classroom</button></div>
    <div class="path">
      <div class="step ${lessonDone >= lessons.length ? 'done' : ''}"><b>1 · Learn the language</b><span>${lessonDone}/${lessons.length} lessons reviewed</span></div>
      <div class="step"><b>2 · Build the message</b><span>Packet builder with every 2.2.2 field</span></div>
      <div class="step ${scDone >= scenarios.length ? 'done' : ''}"><b>3 · Investigate</b><span>${rec() ? `${scDone}/${scenarios.length} scenarios solved` : 'Capture classroom + coach'}</span></div>
      <div class="step ${qDone >= quizzes.length ? 'done' : ''}"><b>4 · Prove it</b><span>${rec() ? `${qDone}/${quizzes.length} checks correct` : 'Field Academy edition'}</span></div>
    </div>
  </section>
  <div class="cards">
    <button class="card clickable" data-act="go" data-to="lessons"><span class="eyebrow">Learn</span><div class="num">${lessons.length}</div><h3 style="margin:0">Guided lessons</h3><p>Bits to Secure Channel, timing, file transfer and reading Aether’s trace.</p></button>
    <button class="card clickable" data-act="go" data-to="captures"><span class="eyebrow">Investigate</span><div class="num">Coach</div><h3 style="margin:0">Conversation coach</h3><p>Checks every capture against the spec’s behaviour rules — sequence, retries, timing, replies.</p></button>
    <button class="card clickable" data-act="go" data-to="integration"><span class="eyebrow">Live</span><div class="num">${LIVE.status === 'live' ? 'On' : 'Trace'}</div><h3 style="margin:0">Live from Aether</h3><p>Follow Readers › OSDP Trace as it happens. Read-only: nothing is sent to the bus.</p></button>
    ${rec() ? `<button class="card clickable" data-act="go" data-to="faults"><span class="eyebrow">Practise</span><div class="num">${scenarios.length}</div><h3 style="margin:0">Troubleshooting scenarios</h3><p>Dead reader, noisy line, twin addresses, key mismatch, slow reader and more.</p></button>` : ''}
  </div>
  <div class="grid2" style="margin-top:16px">
    <div class="panel"><div class="eyebrow">Take a frame apart</div><h2>Every byte has a place and a job.</h2><p>This is a POLL from the controller to reader 2. Click any byte.</p><div id="ovInsp"></div></div>
    <div class="panel"><div class="eyebrow">What’s new in v${VERSION}</div>
      <ul class="small" style="padding-left:18px;margin:0;color:var(--c2);line-height:22px">
        <li>Decoder rebuilt on the same SIA OSDP 2.2.2 field tables as Aether’s OSDP Trace — every command and reply, with page references.</li>
        <li>Conversation coach: sequence, retries, BUSY, NAK handling, 200 ms reply deadline, Secure Channel order, file-transfer flow.</li>
        <li>Live from Aether: follows the Pi’s OSDP Trace; imports trace exports and saved captures.</li>
        <li>Eleven troubleshooting scenarios, four new lessons (timing, conversation rules, file transfer, Aether’s trace) and 18 new knowledge checks.</li>
        <li>Aether’s HV look in dark and light, following the app’s theme.</li>
        <li>Fixes: buzzer tone 0x00 is “no tone (deprecated)”, PDID serial is one 32-bit number, FMT marked deprecated, fictional vendor moved off 00 00 00 (assigned to Xerox).</li>
      </ul>
      ${notice('Starter traffic is simulated, not hardware evidence. Import a real capture or turn on Live from Aether to replace it. Nothing in the Academy transmits to a reader.')}
    </div>
  </div>`;
  mountInspector($('ovInsp'), parse(build({ address: 2, sequence: 1 })), 'ov');
}

// ── Lessons ────────────────────────────────────────────────────────────────
function renderLessons() {
  const l = lessons[S.lesson];
  $('main').innerHTML = head('Lessons · no background assumed', 'Learn by doing.', 'Each lesson ends with something to try in the Academy or on your own capture.') + `
  <div class="lessons">
    <div class="lessonlist" role="list">${lessons.map((x, i) => `<button data-act="lesson" data-i="${i}" aria-current="${i === S.lesson}"><span class="ix">${String(i + 1).padStart(2, '0')}</span><span>${esc(x.tag)}</span><span class="tick">${progress.lessons.includes(i) ? '✓' : ''}</span></button>`).join('')}</div>
    <article class="panel lesson">
      <div class="row between"><span class="badge">Lesson ${S.lesson + 1} of ${lessons.length}</span>${l.ref ? `<span class="small muted">SIA OSDP 2.2.2 · ${esc(l.ref)}</span>` : ''}</div>
      <h2 style="margin-top:12px;font-size:24px;line-height:32px">${esc(l.title)}</h2>
      ${l.body.map((b) => `<p>${esc(b)}</p>`).join('')}
      ${S.lesson === 9 ? handshakeHTML() : ''}
      ${S.lesson === 5 ? timingHTML() : ''}
      ${notice(`<b>Try it</b><br>${esc(l.try)}`)}
      <div class="row"><button class="btn primary" data-act="go" data-to="${l.open}">Open ${esc(PAGES.find((p) => p[0] === l.open)?.[1] || l.open)}</button>
        <button class="btn" data-act="lessonDone">${progress.lessons.includes(S.lesson) ? 'Reviewed ✓' : 'Mark reviewed'}</button>
        <button class="btn ghost" data-act="lesson" data-i="${(S.lesson + 1) % lessons.length}">Next lesson →</button></div>
      <p class="small muted" style="margin-top:12px">Review marks record practice on this browser. They are not a certification.</p>
    </article>
  </div>`;
}
function handshakeHTML() {
  return `<div class="handshake">${SPEC.secureChannelSteps.map((s) => `<div class="hs"><div class="dir">${esc(s.direction.replace('->', ' → '))} · ${esc(s.sbType)}</div><b>${esc(s.message)}</b><p>${esc(s.plain.split('. ')[0])}.</p></div>`).join('')}</div>`;
}
function timingHTML() {
  const T = TIMING;
  return `<div class="stats"><div class="stat"><b>&lt; ${T.REPLY_DELAY_max_ms} ms</b><span>Reply must start (typ. &lt; ${T.REPLY_DELAY_typical_ms} ms)</span></div><div class="stat"><b>~${T.interCharacterTimeout_ms} ms</b><span>Gap that aborts a frame</span></div><div class="stat"><b>${T.pdOfflineAfter_s} s</b><span>Silence before off-line</span></div><div class="stat"><b>≤ 3</b><span>Resends before restarting</span></div></div>`;
}
ACT.lesson = (t) => { S.lesson = +t.dataset.i; renderLessons(); };
ACT.lessonDone = () => { if (!progress.lessons.includes(S.lesson)) progress.lessons.push(S.lesson); saveProgress(); renderLessons(); };

// ── Packet builder ────────────────────────────────────────────────────────
const PRESETS = [
  ['POLL', 'c', 0x60, ''], ['ID', 'c', 0x61, '00'], ['CAP', 'c', 0x62, '00'], ['LED', 'c', 0x69, '00 00 02 05 05 02 00 14 00 01 01 01 01 01'],
  ['BUZ', 'c', 0x6a, '00 02 02 02 03'], ['OUT', 'c', 0x68, '01 05 32 00'], ['TEXT', 'c', 0x6b, '00 01 00 01 01 05 48 45 4C 4C 4F'], ['COMSET', 'c', 0x6e, '03 80 25 00 00'],
  ['MFG', 'c', 0x80, 'AE 7E 00 01 01'], ['FILETRANSFER', 'c', 0x7c, '01 04 00 00 00 00 00 00 00 04 00 DE AD BE EF'],
  ['ACK', 'r', 0x40, ''], ['NAK', 'r', 0x41, '06'], ['PDID', 'r', 0x45, 'AE 7E 00 01 02 39 30 00 00 05 04 0A'], ['PDCAP', 'r', 0x46, '01 04 08 04 04 02 05 02 00 08 01 00 09 01 01 0A 00 02 10 04 00'],
  ['RAW', 'r', 0x50, '00 01 1A 00 81 23 45 40'], ['KEYPAD', 'r', 0x53, '00 04 31 32 33 0D'], ['ISTATR', 'r', 0x49, '00 01 00 03'], ['FTSTAT', 'r', 0x7a, '00 F4 01 00 00 00 00'],
];
const SCB_CHOICES = [['none', 'None (plaintext)'], ['15', 'SCS_15 · MAC, no data (CP→PD)'], ['16', 'SCS_16 · MAC, no data (PD→CP)'], ['17', 'SCS_17 · encrypted + MAC (CP→PD)'], ['18', 'SCS_18 · encrypted + MAC (PD→CP)'], ['11', 'SCS_11 · CHLNG'], ['12', 'SCS_12 · CCRYPT'], ['13', 'SCS_13 · SCRYPT'], ['14', 'SCS_14 · RMAC_I']];
function builderFrame() {
  const b = S.b, payload = bytes(b.payload);
  const t = b.scb === 'none' ? null : parseInt(b.scb, 16);
  if (b.dir === 'c' && b.code === 0x75) throw Error('KEYSET carries a real key. The Academy does not build one — it belongs inside an encrypted session or physically secured install mode.');
  const scb = t == null ? [] : t <= 0x14 ? [3, t, t === 0x14 ? 1 : 0] : [2, t];
  const mac = t != null && t >= 0x15 ? [0, 0, 0, 0] : [];
  return parse(build({ address: b.address, reply: b.dir === 'r', sequence: b.sequence, command: b.code, payload, crcMode: b.crc, scb, mac }));
}
function renderBuilder() {
  const b = S.b, def = (b.dir === 'r' ? REP : CMD).get(b.code);
  const exs = examplesFor(def);
  $('main').innerHTML = head('Packet builder · offline only', 'Build the conversation.', 'Pick a message, set the envelope and fill in the fields. LEN and the check bytes are recalculated as you type. Nothing is transmitted.') + `
  <div class="panel"><div class="row between"><h3 style="margin:0">Start from a template</h3><span class="small muted">Commands on the left, replies on the right</span></div>
    <div class="chips" style="margin-top:10px">${PRESETS.map(([n, d, c]) => `<button class="chip" data-act="preset" data-name="${n}" aria-pressed="${b.dir === d && b.code === c}">${d === 'r' ? '← ' : ''}${n}</button>`).join('')}</div></div>
  <div class="grid2" style="margin-top:16px">
    <div>
      <div class="panel">
        <div class="eyebrow">1 · Envelope</div>
        <div class="form">
          <label class="field">Message<select data-ch="bcode" id="bcode">
            <optgroup label="Commands (controller → reader)">${[...CMD].map(([k, d]) => `<option value="c:${k}" ${b.dir === 'c' && b.code === k ? 'selected' : ''}>${hx(k)} · ${short(d.name)}</option>`).join('')}</optgroup>
            <optgroup label="Replies (reader → controller)">${[...REP].map(([k, d]) => `<option value="r:${k}" ${b.dir === 'r' && b.code === k ? 'selected' : ''}>${hx(k)} · ${short(d.name)}</option>`).join('')}</optgroup></select></label>
          <label class="field">Address (0–126)<input type="number" min="0" max="127" value="${b.address}" data-in="baddr"></label>
          <label class="field">Sequence (SQN)<select data-ch="bseq">${[0, 1, 2, 3].map((x) => `<option ${x === b.sequence ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
          <label class="field">Check bytes<select data-ch="bcrc"><option value="1" ${b.crc ? 'selected' : ''}>CRC-16 (2 bytes)</option><option value="0" ${b.crc ? '' : 'selected'}>Checksum (1 byte)</option></select></label>
          <label class="field" style="grid-column:span 2">Security block<select data-ch="bscb">${SCB_CHOICES.map(([v, l]) => `<option value="${v}" ${b.scb === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <p class="small muted" style="margin:0">${def ? `${esc(def.description)} <span>Expected answer: ${esc((expectedReplies(short(def.name)) ? [...expectedReplies(short(def.name))] : (def.reply || [def.inResponseTo] || [])).map(short).join(', ') || '—')}${b.dir === 'c' ? ', NAK or BUSY' : ''}.</span>` : ''}</p>
      </div>
      <div class="panel">
        <div class="row between"><div class="eyebrow" style="margin:0">2 · Data</div>${exs.length ? `<label class="field" style="flex-direction:row;align-items:center;gap:8px">Spec example<select data-ch="bex" style="width:auto;max-width:260px"><option value="">Choose…</option>${exs.map((e, i) => `<option value="${i}">${esc(e.meaning.slice(0, 70))}${e.meaning.length > 70 ? '…' : ''}</option>`).join('')}</select></label>` : ''}</div>
        <label class="field" style="margin-top:10px">DATA bytes (hex)<textarea data-in="bdata" id="bdata" spellcheck="false" placeholder="No DATA for this message">${esc(b.payload)}</textarea></label>
        <div id="bfields"></div>
        <div id="berror"></div>
      </div>
    </div>
    <div class="panel"><div class="row between"><div class="eyebrow" style="margin:0">3 · Your frame</div><div class="row"><button class="btn sm" data-act="bcopy">Copy hex</button><button class="btn sm" data-act="bsend">Add to classroom</button><button class="btn sm outline" data-act="bexport">Download</button></div></div>
      <pre id="bhex" class="mono" style="font-size:13px"></pre><div id="bout"></div></div>
  </div>`;
  updateBuilder();
}
function updateBuilder() {
  const out = $('bout'); if (!out) return;
  try {
    const p = builderFrame();
    $('bhex').textContent = hex(p.b);
    mountInspector(out, p, 'builder');
    const d = decodeFields(p);
    const def = p.def;
    let editor = '';
    if (!p.encrypted && d.rows.length) {
      editor = `<h4 style="margin-top:14px">Edit by field</h4><div class="form">${d.rows.filter((r) => r.size > 0 && r.size <= 8).map((r) => `<label class="field">${r.record ? `#${r.record} ` : ''}${esc(r.name)}<input data-in="bfield" data-off="${r.off}" data-size="${r.size}" value="${esc(r.hex)}" spellcheck="false" style="font-family:var(--mono)"></label>`).join('')}</div>`;
    }
    if (def?.record) editor += `<div class="row"><button class="btn sm" data-act="brec" data-op="add">Add ${def.recordSize}-byte record</button><button class="btn sm ghost" data-act="brec" data-op="del" ${p.payload.length >= def.recordSize ? '' : 'disabled'}>Remove last record</button></div>`;
    $('bfields').innerHTML = editor;
    const msgs = [];
    if (p.type != null && p.type >= 0x15) msgs.push(notice('Training envelope: the 4-byte MAC is zeros and nothing is encrypted. Real secure frames need session keys.', 'warn'));
    if (p.type != null && p.type <= 0x14) msgs.push(notice('This arranges handshake bytes only. Real cryptograms come from AES with the session keys; see the Key mismatch scenario.', 'warn'));
    if (S.b.address === 127) msgs.push(notice('0x7F is the broadcast/configuration address — use it only with one reader connected.', 'warn'));
    $('berror').innerHTML = msgs.join('');
  } catch (e) { $('berror').innerHTML = notice(esc(e.message), 'error'); $('bhex').textContent = ''; out.innerHTML = ''; $('bfields').innerHTML = ''; }
}
ACT.preset = (t) => { const x = PRESETS.find((p) => p[0] === t.dataset.name); Object.assign(S.b, { dir: x[1], code: x[2], payload: x[3], scb: 'none' }); renderBuilder(); };
INP.bcode = (t) => { const [d, k] = t.value.split(':'); Object.assign(S.b, { dir: d, code: +k, payload: '' }); renderBuilder(); };
INP.baddr = (t) => { const n = +t.value; if (Number.isInteger(n) && n >= 0 && n <= 127) { S.b.address = n; updateBuilder(); } };
INP.bseq = (t) => { S.b.sequence = +t.value; updateBuilder(); };
INP.bcrc = (t) => { S.b.crc = t.value === '1'; updateBuilder(); };
INP.bscb = (t) => { S.b.scb = t.value; updateBuilder(); };
INP.bdata = (t) => { S.b.payload = t.value; updateBuilder(); };
INP.bex = (t) => {
  if (t.value === '') return;
  const def = (S.b.dir === 'r' ? REP : CMD).get(S.b.code), ex = examplesFor(def)[+t.value];
  try {
    const bs = bytes(ex.bytes);
    if (bs[0] === 0x53 && (bs[2] | (bs[3] << 8)) === bs.length) {
      const p = parse(bs); Object.assign(S.b, { address: p.address, dir: p.reply ? 'r' : 'c', code: p.command, sequence: p.sequence, crc: p.crcMode, payload: hex(p.payload), scb: p.type == null ? 'none' : p.type.toString(16) });
      if (p.type != null && p.type <= 0x14) toast('Annex E test vector loaded. The builder sets the key-select byte itself; compare with the original in the classroom.');
    } else S.b.payload = hex(bs);
    renderBuilder();
  } catch (e) { toast(e.message); }
};
INP.bfield = (t) => {
  try {
    const v = bytes(t.value); if (v.length !== +t.dataset.size) return;
    const d = bytes(S.b.payload); d.splice(+t.dataset.off, v.length, ...v); S.b.payload = hex(d); $('bdata').value = S.b.payload;
    const keep = document.activeElement?.dataset?.off; updateBuilder();
    if (keep != null) { const el = document.querySelector(`[data-in="bfield"][data-off="${keep}"]`); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  } catch { /* wait for complete bytes */ }
};
ACT.brec = (t) => {
  const def = (S.b.dir === 'r' ? REP : CMD).get(S.b.code), rs = def.recordSize, d = bytes(S.b.payload);
  if (t.dataset.op === 'add') d.push(...(d.length >= rs ? d.slice(0, rs) : Array(rs).fill(0))); else d.splice(Math.max(0, d.length - rs));
  S.b.payload = hex(d); renderBuilder();
};
ACT.bcopy = () => copy($('bhex').textContent);
ACT.bsend = () => { try { const p = builderFrame(); if (LIVE.status !== 'off') liveStop(); if (C.source.startsWith('Simulated')) setFrames([], 'Built in the packet builder'); pushFrames([record({ fullHex: hex(p.b), ts: Date.now(), origin: 'builder' })]); S.selected = C.frames.length - 1; toast('Added to the capture classroom'); render(); } catch (e) { toast(e.message); } };
ACT.bexport = () => { try { const p = builderFrame(); download('osdp-offline-frame.json', { origin: 'offline-builder', transmitted: false, fullHex: hex(p.b), name: p.entry[0] }); } catch (e) { toast(e.message); } };

// ── Bit bench ─────────────────────────────────────────────────────────────
function renderBits() {
  const v = S.bitValue;
  const explain = S.bitMode === 'CTRL' ? `SQN ${v & 3}; ${v & 4 ? 'CRC-16' : 'checksum'}; ${v & 8 ? 'security block present' : 'no security block'}; bits 4–7 ${v & 0xf0 ? `= ${h2(v & 0xf0)} — reserved, must be 0` : 'clear'}.`
    : S.bitMode === 'ADDR' ? `${v & 0x80 ? 'Reply from' : 'Command to'} address ${v & 0x7f}${(v & 0x7f) === 0x7f ? ' (broadcast/configuration)' : ''}.` : 'Eight independent bits form an unsigned value 0–255.';
  $('main').innerHTML = head('Foundations · binary playground', 'Make every bit count.', 'Flip bits and watch hex, decimal and the protocol meaning change.') + `
  <div class="grid2">
    <div class="panel">
      <div class="row between"><div class="btngroup" role="group" aria-label="Read the byte as">${['CTRL', 'ADDR', 'VALUE'].map((m) => `<button data-act="bitmode" data-m="${m}" aria-pressed="${S.bitMode === m}">${m}</button>`).join('')}</div><div class="row"><button class="btn sm" data-act="bitset" data-v="5">Reset</button><button class="btn sm" data-act="bitset" data-v="130" data-m="ADDR">Reply from 2</button></div></div>
      <div class="bits" style="margin-top:16px">${Array.from({ length: 8 }, (_, j) => { const i = 7 - j; return `<button class="bit" data-act="bit" data-i="${i}" aria-pressed="${!!(v & (1 << i))}"><small>bit ${i}</small>${(v >> i) & 1}<small>${1 << i}</small></button>`; }).join('')}</div>
      <div class="bigvals"><div class="stat"><span>Hex</span><b class="mono">${hx(v)}</b></div><div class="stat"><span>Decimal</span><b>${v}</b></div><div class="stat"><span>Binary</span><b class="mono" style="font-size:15px">${v.toString(2).padStart(8, '0')}</b></div></div>
      ${notice(esc(explain), S.bitMode === 'CTRL' && v & 0xf0 ? 'error' : '')}
      <h4 style="margin-top:16px">Little-endian</h4>
      <div class="row"><label class="field" style="width:110px">Low byte<input id="lo" value="14" data-in="endian" maxlength="2"></label><label class="field" style="width:110px">High byte<input id="hi" value="00" data-in="endian" maxlength="2"></label></div>
      <p id="endian" class="mono small" style="margin-top:8px"></p>
    </div>
    <div class="panel"><h3>A bit’s position gives it a job.</h3><p>In a plain value each position is a power of two. In a protocol field a position can be a flag, or part of a smaller number.</p>
      <div class="tablewrap"><table class="t"><tbody>${(SPEC.packet.ctrlBits.map((c) => [`CTRL ${c.bits} · ${c.mask}`, c.name + ': ' + (c.description || Object.entries(c.values || {}).map(([k, x]) => `${k} = ${x}`).join('; '))])).concat([['ADDR 7 · 0x80', 'Reply flag: 1 on every reader reply.'], ['ADDR 0–6 · 0x7F', 'Reader address 0–126; 127 (0x7F) is broadcast.']]).map(([a, b]) => `<tr><td class="k">${esc(a)}</td><td class="small">${esc(b)}</td></tr>`).join('')}</tbody></table></div></div>
  </div>${rec() ? credentialHTML() : ''}`;
  INP.endian(); if (rec()) INP.card();
}
ACT.bit = (t) => { S.bitValue ^= 1 << +t.dataset.i; renderBits(); };
ACT.bitmode = (t) => { S.bitMode = t.dataset.m; renderBits(); };
ACT.bitset = (t) => { S.bitValue = +t.dataset.v; if (t.dataset.m) S.bitMode = t.dataset.m; renderBits(); };
INP.endian = () => { try { const l = bytes($('lo').value), h = bytes($('hi').value); if (l.length !== 1 || h.length !== 1) throw Error('Enter one hex byte in each box'); $('endian').textContent = `${hx(l[0])} ${hx(h[0])} → ${l[0]} + 256 × ${h[0]} = ${l[0] + 256 * h[0]}`; } catch (e) { $('endian').textContent = e.message; } };
function credentialHTML() {
  return `<div class="panel"><div class="eyebrow">Field Academy · card bits</div><h2>Decode a credential bit image.</h2><p>RAW gives a bit count and the bits, left-justified. The count tells you the length, not the format: use a documented format (Aether: Readers › Card Formats) before naming facility and card numbers.</p>
  <div class="form"><label class="field">Bit count<select id="ccount" data-ch="ccount">${[26, 32, 34, 35, 37, 48, 64].map((n) => `<option>${n}</option>`).join('')}</select></label>
  <label class="field" style="grid-column:span 2">Card data bytes (after the 4-byte RAW header)<input id="cbytes" value="81 23 45 40" data-in="card" spellcheck="false"></label>
  <label class="field">Read as<select id="cfmt" data-ch="card"><option value="opaque">Unknown / opaque</option><option value="h10301">Confirmed H10301 (26-bit)</option></select></label>
  <label class="field">Field start bit<input id="cstart" type="number" value="1" min="0" data-in="card"></label><label class="field">Field width<input id="cwidth" type="number" value="8" min="1" max="64" data-in="card"></label></div>
  <div id="cbits"></div><div id="cmean"></div>
  <div class="row"><label class="field" style="width:260px">How many data bytes are needed?<input id="cq" type="number"></label><button class="btn" data-act="cq" style="align-self:end">Check</button><span id="cqf" class="small" style="align-self:end"></span></div></div>`;
}
INP.ccount = () => { $('cbytes').value = hex(Array(Math.ceil(+$('ccount').value / 8)).fill(0)); INP.card(); };
INP.card = () => {
  try {
    const b = bytes($('cbytes').value), n = +$('ccount').value, need = Math.ceil(n / 8);
    const bits = b.map((x) => x.toString(2).padStart(8, '0')).join('').slice(0, n);
    const st = +$('cstart').value, w = +$('cwidth').value;
    const ok = Number.isInteger(st) && Number.isInteger(w) && st >= 0 && w >= 1 && st + w <= n && b.length === need;
    $('cbits').innerHTML = `<p class="bitstring">${bits.split('').map((c, i) => `<span class="${ok && i >= st && i < st + w ? 'f' : ''}">${c}</span>${(i + 1) % 8 === 0 ? ' ' : ''}`).join('')}</p><p class="small muted">${n} bits need ${need} byte(s); ${b.length} given.${n % 8 ? ` The last ${8 - (n % 8)} bit(s) of the final byte are padding.` : ''}</p>`;
    if (b.length !== need) throw Error(`Enter exactly ${need} data byte(s).`);
    if (!ok) throw Error('The field must fit inside the declared bit count.');
    let text = `Bits ${st}–${st + w - 1} = ${bits.slice(st, st + w)} = ${BigInt('0b' + bits.slice(st, st + w))}. Without a format map this number has no meaning yet.`;
    if ($('cfmt').value === 'h10301') {
      if (n !== 26) throw Error('H10301 is exactly 26 bits.');
      const fc = parseInt(bits.slice(1, 9), 2), cn = parseInt(bits.slice(9, 25), 2), sum = (s) => [...s].reduce((a, x) => a + +x, 0);
      text = `H10301: facility (bits 1–8) = ${fc}, card (bits 9–24) = ${cn}. Even parity over bits 0–12 ${sum(bits.slice(0, 13)) % 2 === 0 ? 'passes' : 'FAILS'}; odd parity over bits 13–25 ${sum(bits.slice(13, 26)) % 2 === 1 ? 'passes' : 'FAILS'}.`;
    }
    $('cmean').innerHTML = notice(esc(text), 'ok');
  } catch (e) { $('cmean').innerHTML = notice(esc(e.message), 'warn'); }
};
ACT.cq = () => { const ok = $('cq').value !== '' && +$('cq').value === Math.ceil(+$('ccount').value / 8); $('cqf').textContent = ok ? 'Correct: divide by 8 and round up.' : 'Divide the bit count by 8 and round up — a partial byte still takes a whole byte.'; };

// ── Capture classroom ─────────────────────────────────────────────────────
function renderCaptures() {
  const co = coach();
  const addrs = co.perAddress.map((a) => a.address).sort((a, b) => a - b);
  $('main').innerHTML = head('Capture classroom', 'Turn a trace into a lesson.', 'Import a capture, follow Aether live, or use the simulated session. Select a frame to take it apart; the coach checks the whole conversation against the spec.') + `
  <div class="panel">
    <div class="row between">
      <div class="row"><span class="badge ${LIVE.status === 'live' || LIVE.status === 'polling' ? 'ok' : C.source.startsWith('Simulated') || C.source.startsWith('Scenario') ? 'brand' : ''}">${esc(C.source)}</span>${C.dropped ? `<span class="badge warn">${C.dropped} oldest dropped (10,000 limit)</span>` : ''}${LIVE.paused ? '<span class="badge warn">Display paused</span>' : ''}</div>
      <div class="row">
        <button class="btn sm" data-act="live" aria-pressed="${LIVE.status !== 'off'}">${LIVE.status !== 'off' ? 'Stop live' : 'Live from Aether'}</button>
        ${LIVE.status !== 'off' ? `<button class="btn sm ghost" data-act="livePause">${LIVE.paused ? 'Resume display' : 'Pause display'}</button>` : `<select data-ch="liveMode" aria-label="Live start point" style="width:auto;min-height:28px;font-size:13px;padding-top:2px;padding-bottom:2px"><option value="now" ${LIVE.mode === 'now' ? 'selected' : ''}>From now</option><option value="buffer" ${LIVE.mode === 'buffer' ? 'selected' : ''}>Include Pi buffer</option></select>`}
        <span class="btn sm filebtn">Import file<input type="file" data-ch="capfile" accept=".json,.csv,.txt,.log,.hex" aria-label="Import capture file"></span>
        <button class="btn sm" data-act="pasteToggle">Paste</button>
        <button class="btn sm ghost" data-act="demo">Simulated session</button>
        <button class="btn sm ghost" data-act="capclear">Clear</button>
        <button class="btn sm outline" data-act="capexport">Export evidence</button>
      </div>
    </div>
    ${LIVE.status === 'error' ? notice(esc(LIVE.err), 'error') : ''}
    <div id="pasteArea" hidden style="margin-top:12px"><textarea id="pasteLog" placeholder="Aether trace export (JSON/CSV), a saved capture, an Academy evidence file, a JSON frames array, or one hex frame per line"></textarea><div class="row" style="margin-top:8px"><button class="btn primary sm" data-act="pasteImport">Import</button></div></div>
  </div>
  <div class="grid2" style="margin-top:16px">
    <div class="panel">
      <div class="row between" style="margin-bottom:10px"><h3 style="margin:0">Conversation</h3><span class="small muted" id="capCount"></span></div>
      <div class="row" style="margin-bottom:10px">
        <input type="search" placeholder="Search name, address or hex" value="${esc(S.search)}" data-in="capsearch" aria-label="Search frames" style="flex:1;min-width:160px">
        <select data-ch="capaddr" aria-label="Address" style="width:auto"><option value="all">All addresses</option>${addrs.map((a) => `<option value="${a}" ${String(a) === S.addrFilter ? 'selected' : ''}>Address ${a}</option>`).join('')}</select>
      </div>
      <div class="row" style="margin-bottom:10px"><label class="check"><input type="checkbox" data-ch="hidepoll" ${S.hidePoll ? 'checked' : ''}>Hide POLL / ACK</label><label class="check"><input type="checkbox" data-ch="onlyflag" ${S.onlyFlagged ? 'checked' : ''}>Only frames the coach flagged</label></div>
      ${rec() ? `<div class="row" style="margin-bottom:10px"><button class="btn sm" data-act="replay">${S.replay ? 'Pause replay' : '▶ Replay'}</button><button class="btn sm ghost" data-act="step" data-d="-1">← Prev</button><button class="btn sm ghost" data-act="step" data-d="1">Next →</button><select id="speed" aria-label="Replay speed" style="width:auto;min-height:28px;font-size:13px"><option value="900">1 frame/s</option><option value="250">4 frames/s</option></select><span class="small muted">↑/↓ keys move too</span></div>` : ''}
      <div class="caplist" id="caplist" tabindex="0" aria-label="Frames"></div>
    </div>
    <div class="panel"><div id="capInsp"></div><hr>
      <div class="row"><button class="btn sm" data-act="mark" id="markBtn">Bookmark</button>${rec() ? '<button class="btn sm" data-act="capquiz">Quiz me on this frame</button>' : ''}</div>
      <label class="field" style="margin-top:10px">Evidence note<textarea id="capNote" data-in="capnote" placeholder="What do you observe? What does it prove? What would you check next?"></textarea></label>
      <div id="capQuiz"></div></div>
  </div>
  <div class="panel" style="margin-top:16px" id="coachPanel"></div>
  ${rec() ? `<div class="panel"><h3>Compare two frames</h3><div class="row"><select data-ch="cmpA" aria-label="Frame A" style="width:auto;max-width:48%">${frameOptions(S.compare[0])}</select><select data-ch="cmpB" aria-label="Frame B" style="width:auto;max-width:48%">${frameOptions(S.compare[1])}</select></div><div id="diff" style="margin-top:12px"></div></div>` : ''}
  ${notice('Capture rules: full frames allow LEN and check-byte validation; payload-only records stay incomplete and no header is invented. A receive-only tap can miss one direction, so a missing partner is not automatically a failure. Pausing or replaying changes the display, never the bus.')}`;
  renderCapList(); showCapture(); renderCoach(); if (rec()) renderDiff();
  $('caplist').onkeydown = (e) => { if (['ArrowDown', 'j'].includes(e.key)) { e.preventDefault(); ACT.step({ dataset: { d: 1 } }); } if (['ArrowUp', 'k'].includes(e.key)) { e.preventDefault(); ACT.step({ dataset: { d: -1 } }); } };
}
const frameOptions = (sel) => C.frames.slice(0, 2000).map((f, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>#${i + 1} ${esc(P(f)?.entry[0] || 'incomplete')}</option>`).join('');
function visibleIdx() {
  const q = S.search.trim().toLowerCase(), co = coach(), out = [];
  const wordRe = new RegExp('(^|[^a-z0-9_])' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  C.frames.forEach((f, i) => {
    const p = P(f);
    if (S.hidePoll && p && (p.name === 'POLL' || p.name === 'ACK')) return;
    if (S.addrFilter !== 'all' && (!p || String(p.address) !== S.addrFilter)) return;
    if (S.onlyFlagged && !(C.byIdx.get(i) || []).some((x) => x.severity === 'error' || x.severity === 'warn')) return;
    if (q && !wordRe.test(`${p?.name || ''} addr ${p?.address ?? ''} ${p ? summary(p) : ''}`.toLowerCase()) && !f.fullHex.replace(/\s/g, '').toLowerCase().includes(q.replace(/\s/g, ''))) return;
    out.push(i);
  });
  return out;
}
function renderCapList() {
  const el = $('caplist'); if (!el) return;
  coach();
  const idx = visibleIdx(), shown = idx.slice(0, S.listLimit);
  const t0 = C.frames.length ? toMs(C.frames[0].ts) : null;
  $('capCount').textContent = `${idx.length} of ${C.frames.length} frames`;
  el.innerHTML = shown.length ? shown.map((i) => {
    const f = C.frames[i], p = P(f), fl = C.byIdx.get(i) || [];
    const worst = fl.reduce((w, x) => (SEVERITY_ORDER[x.severity] < SEVERITY_ORDER[w] ? x.severity : w), 'ok');
    const mark = C.marks.has(f.uid) ? '★' : worst === 'error' ? '<span class="dot error"></span>' : worst === 'warn' ? '<span class="dot warn"></span>' : '';
    return `<button class="caprow" role="option" data-act="pick" data-i="${i}" aria-selected="${i === S.selected}"><span class="n">#${i + 1}</span><span class="tm">${fmtTime(toMs(f.ts), t0)}</span><span class="dir ${p?.reply ? 'r' : ''}">${p ? (p.reply ? '←' : '→') : '?'}</span><span class="a">${p ? p.address : '–'}</span><span class="s">${p ? `s${p.sequence}` : ''}</span><span class="nm">${esc(p?.entry[0] || 'INCOMPLETE')}</span><span class="sum">${esc(p ? summary(p) : f.dataHex ? `payload-only ${f.dataHex}` : 'not a complete frame')}</span><span>${mark}</span></button>`;
  }).join('') + (idx.length > shown.length ? `<div class="more"><button class="btn sm" data-act="more">Show ${Math.min(400, idx.length - shown.length)} more</button></div>` : '')
    : `<div class="empty">${C.frames.length ? 'No frames match the filters.' : LIVE.status !== 'off' ? 'Waiting for traffic on Aether’s OSDP Trace…' : 'No frames yet. Import a capture, paste one, or load the simulated session.'}</div>`;
  const s = el.querySelector('[aria-selected="true"]'); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' });
}
function showCapture() {
  const f = C.frames[S.selected], box = $('capInsp'); if (!box) return;
  if (!f) { box.innerHTML = '<div class="empty">Select a frame.</div>'; return; }
  const p = P(f);
  if (p) mountInspector(box, p, 'cap', f);
  else { let msg = 'Not a frame'; try { parse(f.fullHex); } catch (e) { msg = e.message; } box.innerHTML = notice(esc(msg), 'error') + `<pre>${esc(f.fullHex || f.dataHex || '(no bytes)')}</pre><p class="small">Payload-only or damaged records are kept as they are; the Academy never invents a header for them.</p>`; }
  const fl = C.byIdx.get(S.selected) || [];
  if (fl.length) box.insertAdjacentHTML('beforeend', `<h4 style="margin-top:12px">Coach on this frame</h4>${fl.map((x) => notice(`${sevBadge(x.severity)} <b>${esc(x.title)}</b> — ${esc(x.text)} <span class="mono small muted">${esc(x.rule)}</span>`, x.severity === 'error' ? 'error' : x.severity === 'warn' ? 'warn' : x.severity === 'ok' ? 'ok' : '')).join('')}`);
  if ($('capNote')) $('capNote').value = C.notes[f.uid] || '';
  if ($('markBtn')) $('markBtn').textContent = C.marks.has(f.uid) ? 'Bookmarked ★' : 'Bookmark';
  if ($('capQuiz')) $('capQuiz').innerHTML = '';
}
function renderCoach() {
  const el = $('coachPanel'); if (!el) return;
  const co = coach(), st = co.stats;
  const list = co.findings.filter((x) => S.sevFilter === 'all' || (S.sevFilter === 'problems' ? x.severity === 'error' || x.severity === 'warn' : x.severity === 'info' || x.severity === 'ok'));
  const counts = { error: 0, warn: 0, info: 0, ok: 0 }; co.findings.forEach((x) => counts[x.severity]++);
  el.innerHTML = `<div class="head"><div><div class="eyebrow">Conversation coach</div><h3>${counts.error + counts.warn ? `${counts.error + counts.warn} thing${counts.error + counts.warn === 1 ? '' : 's'} to look at` : 'No rule problems found'}</h3></div>
    <div class="btngroup" role="group" aria-label="Show findings">${[['problems', `Problems (${counts.error + counts.warn})`], ['notes', `Notes (${counts.info + counts.ok})`], ['all', 'All']].map(([k, l]) => `<button data-act="sev" data-k="${k}" aria-pressed="${S.sevFilter === k}">${l}</button>`).join('')}</div></div>
    <div class="stats">${[['Frames', st.frames], ['Commands', st.commands], ['Replies', st.replies], ['No reply', st.timeouts], ['NAK', st.naks], ['Bad frames', st.bad], ['Reply avg', st.replyAvg == null ? '—' : `${st.replyAvg} ms`], ['Reply max', st.replyMax == null ? '—' : `${st.replyMax} ms`]].map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div>
    <div class="grid2 even">
      <div class="findings">${list.length ? list.slice(0, 300).map((x) => `<button class="finding" data-act="finding" data-i="${x.idx ?? ''}"><span>${sevBadge(x.severity)}<br><span class="rule">${x.idx == null ? 'capture' : `#${x.idx + 1}`}</span></span><span><b>${esc(x.title)}</b> — ${esc(x.text)}<br><span class="rule">rule: ${esc(x.rule)}</span></span></button>`).join('') : `<div class="empty">${S.sevFilter === 'problems' ? 'Nothing breaks the spec’s behaviour rules in this capture.' : 'No notes.'}</div>`}</div>
      <div><div class="tablewrap"><table class="t"><thead><tr><th>Address</th><th>Cmds</th><th>Replies</th><th>No reply</th><th>NAK</th><th>Slowest</th></tr></thead><tbody>${co.perAddress.sort((a, b) => a.address - b.address).map((a) => `<tr><td class="k">${a.address}</td><td>${a.commands}</td><td>${a.replies}</td><td>${a.timeouts}</td><td>${a.naks}</td><td>${a.maxReplyMs ? `${a.maxReplyMs} ms` : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No frames</td></tr>'}</tbody></table></div>
      <p class="small muted" style="margin-top:8px">Findings are observations about this capture against SIA OSDP 2.2.2 behaviour rules, not a diagnosis. Click one to jump to its frame; open the Spec reference for the full rule.</p></div>
    </div>`;
}
ACT.sev = (t) => { S.sevFilter = t.dataset.k; renderCoach(); };
ACT.finding = (t) => { if (t.dataset.i === '') return; S.selected = +t.dataset.i; if (!visibleIdx().includes(S.selected)) { S.search = ''; S.hidePoll = false; S.onlyFlagged = false; S.addrFilter = 'all'; renderCaptures(); } else { renderCapList(); showCapture(); } $('capInsp')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); };
ACT.pick = (t) => { S.selected = +t.dataset.i; renderCapList(); showCapture(); };
ACT.more = () => { S.listLimit += 400; renderCapList(); };
ACT.step = (t) => { const idx = visibleIdx(); if (!idx.length) return; const at = idx.indexOf(S.selected); S.selected = idx[Math.max(0, Math.min(idx.length - 1, (at < 0 ? 0 : at) + +t.dataset.d))]; renderCapList(); showCapture(); };
ACT.replay = (t) => {
  if (S.replay) { clearInterval(S.replay); S.replay = null; t.textContent = '▶ Replay'; return; }
  S.replay = setInterval(() => { const idx = visibleIdx(), at = idx.indexOf(S.selected); if (S.page !== 'captures' || at >= idx.length - 1) { clearInterval(S.replay); S.replay = null; if (S.page === 'captures') renderCaptures(); return; } S.selected = idx[at + 1]; renderCapList(); showCapture(); }, +($('speed')?.value || 900));
  t.textContent = 'Pause replay';
};
INP.capsearch = (t) => { S.search = t.value; S.listLimit = 400; renderCapList(); };
INP.capaddr = (t) => { S.addrFilter = t.value; renderCapList(); };
INP.hidepoll = (t) => { S.hidePoll = t.checked; renderCapList(); };
INP.onlyflag = (t) => { S.onlyFlagged = t.checked; renderCapList(); };
INP.capnote = (t) => { const f = C.frames[S.selected]; if (f) C.notes[f.uid] = t.value; };
ACT.mark = () => { const f = C.frames[S.selected]; if (!f) return; C.marks.has(f.uid) ? C.marks.delete(f.uid) : C.marks.add(f.uid); renderCapList(); showCapture(); };
ACT.pasteToggle = () => { $('pasteArea').hidden = !$('pasteArea').hidden; };
ACT.pasteImport = () => { try { importText($('pasteLog').value, 'pasted text'); } catch (e) { toast(e.message); } };
ACT.demo = () => { liveStop(); setFrames(simulatedSession().map((f) => record(f, 'simulation')), 'Simulated session · generated training traffic'); render(); };
ACT.capclear = () => { liveStop(); setFrames([], 'Empty classroom'); render(); };
INP.capfile = async (t) => { const f = t.files?.[0]; if (!f) return; try { if (f.size > 20 * 1024 * 1024) throw Error('Import limit is 20 MB — split the capture.'); importText(await f.text(), f.name); } catch (e) { toast(e.message); } };
ACT.capexport = () => {
  const i = new Map(C.frames.map((f, k) => [f.uid, k]));
  download('aether-osdp-academy-evidence.json', { format: 'aether-osdp-academy-evidence', version: 2, source: C.source, exported: new Date().toISOString(), droppedLive: C.dropped,
    frames: C.frames.map((f) => ({ fullHex: f.fullHex, ts: f.ts, port: f.port || undefined, origin: f.origin, dataHex: f.dataHex || undefined })),
    notes: Object.entries(C.notes).filter(([, v]) => v).map(([u, v]) => [i.get(+u), v]).filter(([k]) => k != null),
    bookmarks: [...C.marks].map((u) => i.get(u)).filter((k) => k != null),
    coach: coach().findings.map((x) => ({ frame: x.idx == null ? null : x.idx + 1, severity: x.severity, rule: x.rule, title: x.title, text: x.text })) });
};
ACT.capquiz = () => {
  const p = P(C.frames[S.selected]); if (!p) { toast('Pick a complete frame first'); return; }
  $('capQuiz').innerHTML = notice(`<b>Decode frame #${S.selected + 1} from its bytes</b><div class="form"><label class="field">Address<input id="qa" type="number"></label><label class="field">Direction<select id="qd"><option value="">Choose</option><option value="c">Command</option><option value="r">Reply</option></select></label><label class="field">SQN<input id="qs" type="number"></label><label class="field">Check mode<select id="qc"><option value="">Choose</option><option value="crc">CRC-16</option><option value="sum">Checksum</option></select></label></div><button class="btn sm primary" data-act="capquizCheck">Check against the bytes</button><div id="qf" style="margin-top:8px"></div>`);
};
ACT.capquizCheck = () => {
  const p = P(C.frames[S.selected]); const ok = $('qa').value !== '' && +$('qa').value === p.address && $('qd').value === (p.reply ? 'r' : 'c') && $('qs').value !== '' && +$('qs').value === p.sequence && $('qc').value === (p.crcMode ? 'crc' : 'sum');
  $('qf').innerHTML = ok ? '<span class="badge ok">Correct</span> ADDR bits 0–6, ADDR bit 7, CTRL bits 0–1 and CTRL bit 2 all agree.' : `<span class="badge warn">Not quite</span> Address ${p.address} (ADDR ${h2(p.b[1])} AND 0x7F), ${p.reply ? 'reply' : 'command'} (bit 7 = ${p.b[1] >> 7}), SQN ${p.sequence} and ${p.crcMode ? 'CRC' : 'checksum'} (CTRL ${h2(p.ctrl)}).`;
};
function renderDiff() {
  const el = $('diff'); if (!el) return;
  const A = C.frames[S.compare[0]], B = C.frames[S.compare[1]];
  try {
    const a = bytes(A.fullHex), b = bytes(B.fullHex), n = Math.max(a.length, b.length), pa = P(A), pb = P(B);
    const name = (p, i) => p?.fields[i]?.name || '';
    el.innerHTML = `<p class="small muted">Byte-by-offset comparison. An extra field shifts every later offset, so a difference is a place to look, not a meaning.</p><div class="tablewrap" style="max-height:300px"><table class="t"><thead><tr><th>Offset</th><th>A</th><th>A field</th><th>B</th><th>B field</th></tr></thead><tbody>${Array.from({ length: n }, (_, i) => `<tr class="${a[i] === b[i] ? '' : 'diff'}"><td class="k">${i}</td><td class="v">${a[i] == null ? '—' : hx(a[i])}</td><td class="small">${esc(name(pa, i))}</td><td class="v">${b[i] == null ? '—' : hx(b[i])}</td><td class="small">${esc(name(pb, i))}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (e) { el.innerHTML = `<p class="small muted">${C.frames.length < 2 ? 'Need two frames.' : esc(e.message)}</p>`; }
}
INP.cmpA = (t) => { S.compare[0] = +t.value; renderDiff(); };
INP.cmpB = (t) => { S.compare[1] = +t.value; renderDiff(); };

// ── import ────────────────────────────────────────────────────────────────
function csvRows(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (q && text[i + 1] === '"') { cell += '"'; i++; } else q = !q; }
    else if (!q && (c === ',' || c === '\n')) { row.push(cell.replace(/\r$/, '')); cell = ''; if (c === '\n') { rows.push(row); row = []; } }
    else cell += c;
  }
  if (q) throw Error('Unclosed quote in the CSV');
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()) && !String(r[0]).startsWith('#'));
}
// Find the frame in a text line: every byte-looking token is a candidate; take the first 0x53
// whose LEN covers exactly the rest of the line and whose check bytes pass, so timestamps
// such as 10:53:07 or labels such as "RX 0x53" are skipped.
export function frameFromLine(line) {
  const toks = [...line.matchAll(/(?:0x)?([0-9a-f]{2})(?![0-9a-f])/gi)].map((m) => parseInt(m[1], 16));
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== 0x53 || i + 4 >= toks.length) continue;
    const len = toks[i + 2] | (toks[i + 3] << 8), fr = toks.slice(i, i + len);
    if (fr.length === len && i + len === toks.length) { try { const p = parse(fr); if (p.ok && !p.issues.length) return hex(fr); } catch { /* next */ } }
  }
  const m = line.match(/(?:0x)?53(?:[\s,:]*(?:0x)?[0-9a-f]{2}){5,}/i);
  return m ? m[0] : line.trim();
}
export function parseImport(text) {
  const t = text.trim(); let list, label = '', notes = null, marks = null;
  if (!t) throw Error('Nothing to import');
  if (t[0] === '{' || t[0] === '[') {
    const j = JSON.parse(t);
    list = Array.isArray(j) ? j : j.frames;
    if (!Array.isArray(list)) throw Error('JSON needs an array of frames, or an object with a “frames” array');
    if (j.format === 'aether-osdp-academy-evidence') { label = 'Academy evidence'; notes = j.notes; marks = j.bookmarks; }
    else if (j.exportedAt && j.health) label = `Aether trace export (${j.source || 'trace'})`;
    else if (j.version && j.savedAt) label = `Aether saved capture (${j.source || 'capture'})`;
  } else if (/^[^\n]*,/.test(t) && /hex/i.test(t.split('\n')[0])) {
    const r = csvRows(t), h = r.shift().map((x) => x.trim());
    const col = (n) => h.findIndex((x) => x.toLowerCase() === n.toLowerCase());
    const iFull = [col('fullHex'), col('Hex'), col('rawHex')].find((x) => x >= 0);
    const iLegacy = col('DataHex') >= 0 && col('Decode') >= 0 && col('CommandName') >= 0 ? col('DataHex') : -1;
    const iData = col('DataHex'), iTs = [col('ts'), col('Timestamp'), col('Time'), col('timestamp')].find((x) => x >= 0);
    list = r.map((x) => ({ fullHex: iFull != null ? x[iFull] : iLegacy >= 0 ? x[iLegacy] : '', dataHex: iData >= 0 ? x[iData] : '', ts: iTs != null ? x[iTs] : '' }));
    label = h.includes('Plain English') ? 'Aether trace CSV' : 'CSV';
  } else {
    list = t.split(/\r?\n/).filter((x) => x.trim()).map((line) => ({ fullHex: frameFromLine(line) }));
    label = 'hex lines';
  }
  if (!list.length) throw Error('No frames found');
  if (list.length > MAX_FRAMES) throw Error(`Import limit is ${MAX_FRAMES.toLocaleString()} frames — split the capture.`);
  return { list, label, notes, marks };
}
function importText(text, name) {
  const { list, label, notes, marks } = parseImport(text);
  liveStop();
  const frames = list.map((f) => record(f, 'imported'));
  const valid = frames.filter((f) => P(f)).length;
  setFrames(frames, `${name}${label ? ` · ${label}` : ''} · ${valid} complete, ${frames.length - valid} incomplete`);
  if (notes) for (const [i, v] of notes) if (frames[i]) C.notes[frames[i].uid] = v;
  if (marks) for (const i of marks) if (frames[i]) C.marks.add(frames[i].uid);
  toast(`Imported ${frames.length} records; original bytes kept`);
  S.page = 'captures'; render();
}

// ── live from Aether ──────────────────────────────────────────────────────
const LIVE = { gen: 0, status: 'off', err: '', got: 0, mode: 'now', paused: false, pending: [], lastId: 0, sock: null, timer: null };
export function liveBase() {
  const o = store.get('academy.api', ''); if (o) { try { return new URL(String(o)).origin; } catch { return null; } }
  if (location.protocol === 'file:') return null;
  return location.port === '3001' || location.port === '' ? '' : `${location.protocol}//${location.hostname}:3001`;
}
function fromTrace(f) { return record({ fullHex: f.hex, ts: f.ts, port: f.port, origin: `aether-${f.direction || 'trace'}`, aether: { summary: f.summary, name: f.name, checkOk: f.checkOk, errors: f.errors } }, 'aether'); }
function liveIngest(list) {
  if (!list.length) return;
  LIVE.got += list.length;
  if (LIVE.paused) { LIVE.pending.push(...list); if (LIVE.pending.length > MAX_FRAMES) { C.dropped += LIVE.pending.length - MAX_FRAMES; LIVE.pending.splice(0, LIVE.pending.length - MAX_FRAMES); } return; }
  const follow = S.selected >= C.frames.length - 1;
  pushFrames(list); if (follow) S.selected = C.frames.length - 1;
  scheduleLiveRender();
}
function scheduleLiveRender() {
  if (scheduleLiveRender.t) return;
  scheduleLiveRender.t = setTimeout(() => {
    scheduleLiveRender.t = null; renderLiveChip();
    const c = $('nav').querySelector('[data-page="captures"] .count'); if (c) c.textContent = C.frames.length > 999 ? Math.round(C.frames.length / 1000) + 'k' : C.frames.length;
    if (S.page === 'captures' && !S.replay) { const a = document.activeElement; if (a && a.id === 'capNote') { renderCapList(); return; } renderCapList(); showCapture(); renderCoach(); }
  }, 400);
}
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(Error('script')); document.head.appendChild(s); }); }
async function liveStart() {
  const base = liveBase();
  if (base == null) { LIVE.status = 'error'; LIVE.err = 'Live mode needs the Academy to be opened from Aether (http://<pi>:3001/osdp-training/) or an Aether address set on the Aether integration page.'; render(); return; }
  const gen = ++LIVE.gen; const stale = () => gen !== LIVE.gen || LIVE.status === 'off';
  LIVE.status = 'connecting'; LIVE.err = ''; LIVE.got = 0; LIVE.paused = false; LIVE.pending = []; render();
  const catchUp = async () => {  // frames missed between the snapshot and a (re)connect
    try { const j = await (await fetch(`${base}/api/osdp/trace/snapshot?since=${LIVE.lastId}`, { cache: 'no-store' })).json(); if (stale()) return;
      if (j.lastId < LIVE.lastId) { LIVE.lastId = 0; return; }
      const fr = (j.frames || []).filter((f) => f.id > LIVE.lastId); if (fr.length) { LIVE.lastId = fr[fr.length - 1].id; liveIngest(fr.map(fromTrace)); } } catch { /* next event will do */ }
  };
  try {
    const r = await fetch(`${base}/api/osdp/trace/snapshot?since=${LIVE.mode === 'buffer' ? 0 : 2147483647}`, { cache: 'no-store' });
    if (!r.ok) throw Error(`Aether answered HTTP ${r.status}. This Aether may predate the OSDP Trace.`);
    const j = await r.json(); if (stale()) return; if (!j.success) throw Error('Aether did not return a trace snapshot');
    LIVE.lastId = j.lastId || 0;
    setFrames([], `Live · Aether OSDP Trace (${j.source || 'trace'})${base ? ` · ${base.replace(/^https?:\/\//, '')}` : ''}`);
    if (LIVE.mode === 'buffer') { const fr = (j.frames || []).slice(-2000); LIVE.got = 0; liveIngest(fr.map(fromTrace)); }
  } catch (e) { if (stale()) return; LIVE.status = 'error'; LIVE.err = `Could not reach Aether’s OSDP Trace${base ? ` at ${base}` : ''}: ${e.message}`; render(); return; }
  try {
    if (!window.io) await loadScript(`${base}/socket.io/socket.io.js`);
    if (stale()) return;
    const s = window.io(base || undefined, { transports: ['websocket', 'polling'] }); LIVE.sock = s;
    s.on('connect', () => { if (stale()) { s.disconnect(); return; } LIVE.status = 'live'; renderLiveChip(); if (S.page === 'captures') renderCaptures(); catchUp(); });
    s.on('disconnect', () => { if (LIVE.status !== 'off') { LIVE.status = 'connecting'; renderLiveChip(); } });
    s.on('osdp-trace-frame', (f) => { if (f.id <= LIVE.lastId) return; LIVE.lastId = f.id; liveIngest([fromTrace(f)]); });
    s.on('osdp-trace-cleared', () => { LIVE.lastId = 0; toast('Aether’s trace was cleared on the Pi; the classroom keeps what it has.'); });
  } catch {
    if (stale()) return;
    // Socket.IO client not available: poll the snapshot instead (heavier, so every 2 s).
    LIVE.status = 'polling'; render();
    const poll = async () => {
      if (stale()) return;
      try {
        const j = await (await fetch(`${base}/api/osdp/trace/snapshot?since=${LIVE.lastId}`, { cache: 'no-store' })).json();
        if (stale()) return;
        if (j.lastId < LIVE.lastId) LIVE.lastId = 0;
        const fr = (j.frames || []).filter((f) => f.id > LIVE.lastId); if (fr.length) LIVE.lastId = fr[fr.length - 1].id;
        liveIngest(fr.map(fromTrace));
      } catch { /* keep trying */ }
      LIVE.timer = setTimeout(poll, document.hidden ? 5000 : 2000);
    };
    poll();
  }
}
function liveStop() {
  if (LIVE.status === 'off') return;
  LIVE.gen++; LIVE.status = 'off'; clearTimeout(LIVE.timer); try { LIVE.sock?.disconnect(); } catch { /* */ } LIVE.sock = null;
  if (LIVE.pending.length) { pushFrames(LIVE.pending); LIVE.pending = []; }
  C.source = C.source.replace(/^Live/, 'Recorded live'); renderLiveChip();
}
ACT.live = () => { if (LIVE.status !== 'off') { liveStop(); render(); } else liveStart(); };
ACT.livePause = () => { LIVE.paused = !LIVE.paused; if (!LIVE.paused && LIVE.pending.length) { pushFrames(LIVE.pending); LIVE.pending = []; } renderCaptures(); };
INP.liveMode = (t) => { LIVE.mode = t.value; };

// host API (same-origin): window.AetherOSDPTraining and postMessage
window.AetherOSDPTraining = {
  ingestFrame(f) { if (!C.source.startsWith('Host')) { liveStop(); setFrames([], 'Host bridge · frames from the page that embeds the Academy'); } pushFrames([record(f, 'host')]); scheduleLiveRender(); },
  pauseDisplay(v) { LIVE.paused = !!v; if (!v && LIVE.pending.length) { pushFrames(LIVE.pending); LIVE.pending = []; } scheduleLiveRender(); },
  loadCapture(list) { importText(JSON.stringify({ frames: list }), 'host capture'); },
  getEvidence() { return { source: C.source, frames: C.frames, notes: C.notes, bookmarks: [...C.marks], dropped: C.dropped, coach: coach().findings }; },
  version: VERSION,
};
window.addEventListener('message', (e) => { if (e.origin !== location.origin) return; if (e.data?.type === 'aether-osdp-frame') window.AetherOSDPTraining.ingestFrame(e.data.frame); });

// ── Troubleshooting ───────────────────────────────────────────────────────
function renderFaults() {
  const sc = scenarios.find((s) => s.id === S.scenario);
  $('main').innerHTML = head('Field Academy · troubleshooting', 'Separate what you see from what you think.', 'Each scenario is a short simulated capture. Write your reasoning first, then reveal the coach’s view.') + `
  <div class="cards">${scenarios.map((s, i) => `<button class="card clickable" data-act="scen" data-id="${s.id}" ${S.scenario === s.id ? 'style="border-color:rgb(var(--hv-brand))"' : ''}><div class="row between"><span class="eyebrow" style="margin:0">Case ${String(i + 1).padStart(2, '0')}</span>${progress.scenarios.includes(s.id) ? '<span class="badge ok">Solved</span>' : ''}</div><h3 style="margin:0">${esc(s.title)}</h3><p>${esc(s.symptom)}</p></button>`).join('')}</div>
  ${sc ? scenarioHTML(sc) : ''}
  <div class="grid2" style="margin-top:16px">
    <div class="panel"><h3>Fault bench</h3><p class="small">Break a frame on purpose and watch what each check catches.</p>
      <label class="field">Complete frame<textarea id="faultIn" data-in="fault" spellcheck="false">${esc(S.faultHex || hex(build({ address: 2 })))}</textarea></label>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="fflip">Flip a bit in the code</button><button class="btn sm" data-act="flen">Add 1 to LEN</button><button class="btn sm" data-act="frsv">Set a reserved CTRL bit</button><button class="btn sm primary" data-act="ffix">Recalculate check bytes</button></div>
      <div id="faultStatus"></div>
      <label class="field" style="margin-top:12px">Support reasoning<textarea id="faultReason" placeholder="Observed fact → possible causes → next evidence to collect"></textarea></label>
      <button class="btn sm outline" data-act="fexport" style="margin-top:8px">Export worksheet</button></div>
    <div class="panel" id="faultInsp"></div>
  </div>
  <div class="panel"><h3>A protocol reply does not prove a physical outcome.</h3><p>ACK proves the reader accepted a command. RAW proves a card was read. An LED command describes a requested light. A door moving, a privilege being granted or a vendor setting changing each need their own evidence — the panel’s event log, a door contact, a second capture after a restart.</p></div>`;
  INP.fault();
}
function scenarioHTML(sc) {
  const co = analyze(sc.frames()), probs = co.findings.filter((x) => x.severity !== 'info' || /reset|restart|Replies only/i.test(x.title));
  return `<div class="panel" style="margin-top:16px"><div class="row between"><div><div class="eyebrow">Scenario</div><h2 style="margin:0">${esc(sc.title)}</h2></div><div class="row"><button class="btn" data-act="scenOpen">Open in classroom</button>${progress.scenarios.includes(sc.id) ? '<span class="badge ok">Solved</span>' : `<button class="btn primary" data-act="scenDone">Mark solved</button>`}</div></div>
    <p style="margin-top:8px"><b>Symptom:</b> ${esc(sc.symptom)}</p>${notice(`<b>Question</b><br>${esc(sc.ask)}`)}
    <label class="field">Your reasoning (stays on this page)<textarea id="scenWork" placeholder="What do the frames show? Which rule does it touch? What would you check next?"></textarea></label>
    <div class="row" style="margin-top:8px"><button class="btn" data-act="reveal">${S.reveal ? 'Hide the answer' : 'Reveal the coach’s view'}</button><span class="small muted">${sc.frames().length} frames · simulated</span></div>
    ${S.reveal ? `<div class="grid2 even" style="margin-top:12px"><div><h4>What the capture shows</h4><p>${esc(sc.observe)}</p><h4>Coach findings</h4>${probs.slice(0, 8).map((x) => `<div class="small" style="margin:4px 0">${sevBadge(x.severity)} <b>${esc(x.title)}</b> — ${esc(x.text)}</div>`).join('') || '<p class="small muted">No rule problems — the protocol worked.</p>'}</div>
      <div><h4>Likely causes</h4><ul class="small" style="padding-left:18px;color:var(--c2)">${sc.causes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><h4>Next checks</h4><ul class="small" style="padding-left:18px;color:var(--c2)">${sc.next.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : ''}
  </div>`;
}
ACT.scen = (t) => { S.scenario = S.scenario === t.dataset.id ? null : t.dataset.id; S.reveal = false; renderFaults(); };
ACT.reveal = () => { const w = $('scenWork')?.value; S.reveal = !S.reveal; renderFaults(); if ($('scenWork')) $('scenWork').value = w || ''; };
ACT.scenOpen = () => { const sc = scenarios.find((s) => s.id === S.scenario); liveStop(); setFrames(sc.frames().map((f) => record(f, 'scenario')), `Scenario · ${sc.title} (simulated)`); S.sevFilter = 'all'; navigate('captures'); };
ACT.scenDone = () => { if (!progress.scenarios.includes(S.scenario)) progress.scenarios.push(S.scenario); saveProgress(); renderFaults(); };
INP.fault = () => {
  S.faultHex = $('faultIn').value;
  try { const p = parse(S.faultHex); mountInspector($('faultInsp'), p, 'fault'); $('faultStatus').innerHTML = p.issues.length ? notice(`<b>Observed</b><br>${p.issues.map(esc).join('<br>')}`, 'error') : notice('LEN and check bytes pass. Now look at what the message means.', 'ok'); }
  catch (e) { $('faultStatus').innerHTML = notice(esc(e.message), 'error'); $('faultInsp').innerHTML = ''; }
};
function faultEdit(fn, msg) { try { const b = bytes($('faultIn').value); if (b.length < 7) throw Error('Load a complete frame first'); fn(b); $('faultIn').value = hex(b); INP.fault(); if (msg) toast(msg); } catch (e) { toast(e.message); } }
ACT.fflip = () => faultEdit((b) => { const at = b[4] & 8 ? 5 + b[5] : 5; b[at] ^= 1; });
ACT.flen = () => faultEdit((b) => { b[2] = (b[2] + 1) & 255; });
ACT.frsv = () => faultEdit((b) => { b[4] |= 0x10; });
ACT.ffix = () => faultEdit((b) => { const n = b[4] & 4 ? 2 : 1, body = b.slice(0, -n); b.length = 0; if (n === 2) { const c = crc(body); b.push(...body, c & 255, c >> 8); } else b.push(...body, checksum(body)); }, 'Check bytes recalculated — LEN and meaning problems may remain');
ACT.fexport = () => download('osdp-support-worksheet.json', { origin: 'offline-fault-exercise', fullHex: $('faultIn').value, reasoning: $('faultReason').value, scenario: S.scenario });

// ── Knowledge checks ──────────────────────────────────────────────────────
function renderQuiz() {
  const ids = quizzes.map((q, i) => i).filter((i) => quizzes[i].level === S.quizLevel), idx = ids[S.quizIndex % ids.length], q = quizzes[idx];
  const picked = S.quizPicked;
  $('main').innerHTML = head('Field Academy · knowledge checks', 'Build confidence one layer at a time.', 'Five levels from bits to vendor evidence. Every answer explains itself; repeat as often as you like.') + `
  <div class="btngroup" role="group" aria-label="Level">${levels.map((l, i) => { const lv = quizzes.map((x, k) => k).filter((k) => quizzes[k].level === i + 1); const done = lv.filter((k) => progress.answers[k]).length; return `<button data-act="qlevel" data-l="${i + 1}" aria-pressed="${S.quizLevel === i + 1}">${i + 1} · ${l} <span class="muted">${done}/${lv.length}</span></button>`; }).join('')}</div>
  <div class="grid2" style="margin-top:16px">
    <div class="panel"><span class="badge">Level ${S.quizLevel} · question ${(S.quizIndex % ids.length) + 1} of ${ids.length}</span>
      <h2 style="margin-top:14px">${esc(q.q)}</h2>
      ${q.options.map((a, i) => `<button class="answer ${picked == null ? '' : i === q.answer ? 'right' : i === picked ? 'wrong' : ''}" data-act="qanswer" data-i="${i}" ${picked != null ? 'aria-disabled="true"' : ''}><span class="key">${String.fromCharCode(65 + i)}</span>${esc(a)}</button>`).join('')}
      <div id="qfb">${picked == null ? '' : notice(`<b>${picked === q.answer ? 'Correct.' : 'Not quite.'}</b> ${esc(q.why)}`, picked === q.answer ? 'ok' : 'warn')}</div>
      <div class="row"><button class="btn ${picked == null ? 'ghost' : 'primary'}" data-act="qnext">Next question →</button></div></div>
    <div class="panel"><h3>From memory to evidence</h3><p>After a level, open a capture and use “Quiz me on this frame”. It checks your reading of address, direction, sequence and check mode against the actual bytes.</p><button class="btn" data-act="go" data-to="captures">Practise on a capture</button><hr>
      <h4>Your record</h4>${levels.map((l, i) => { const lv = quizzes.map((x, k) => k).filter((k) => quizzes[k].level === i + 1); const done = lv.filter((k) => progress.answers[k]).length; return `<div class="small" style="margin:8px 0 4px">${i + 1} · ${l} — ${done}/${lv.length}</div><div class="bar"><i style="width:${(done / lv.length) * 100}%"></i></div>`; }).join('')}
      <p class="small muted" style="margin-top:12px">Stored on this browser. A learning aid, not a certification.</p></div>
  </div>`;
  S._qidx = idx;
}
ACT.qlevel = (t) => { S.quizLevel = +t.dataset.l; S.quizIndex = 0; S.quizPicked = null; renderQuiz(); };
ACT.qanswer = (t) => { if (S.quizPicked != null) return; S.quizPicked = +t.dataset.i; if (S.quizPicked === quizzes[S._qidx].answer) { progress.answers[S._qidx] = true; saveProgress(); } renderQuiz(); };
ACT.qnext = () => { S.quizIndex++; S.quizPicked = null; renderQuiz(); };

// ── Vendor lab ────────────────────────────────────────────────────────────
const SAMPLE_SCHEMA = { name: 'Fictional training profile selector', vendorHex: 'AE7E00', model: 'TRAINING-PD', firmware: 'simulated-1.0', document: 'AETHER fictional exercise, rev 2 (not a real product command)', subcommand: 1, requestLength: 5,
  fields: [{ name: 'Profile selector', offset: 4, width: 1, encoding: 'uint', endian: 'little', unit: 'profile', description: '0 = baseline, 1 = extended demo. Fictional values only.' }] };
function renderMfg() {
  $('main').innerHTML = head('Vendor lab · documented extensions', 'Decode the vendor contract.', 'Build, scope and check manufacturer exchanges. An unknown payload stays unknown until a matching document is supplied.') + `
  <div class="grid2">
    <div class="panel"><h3>Build a manufacturer command</h3><p class="small">The exercise uses AE 7E 00 — a locally administered value (bit 1 of the first byte set) that can never be a company’s assigned OUI. Never send it, or any borrowed OUI, to a real reader.</p>
      <div class="form"><label class="field">Vendor OUI (3 bytes)<input id="mv" value="AE 7E 00"></label><label class="field">Command_ID<input id="ms" value="01"></label><label class="field">Vendor data<input id="md" value="01"></label></div>
      <div class="row"><button class="btn primary" data-act="mbuild">Build offline MFG</button><label class="check"><input type="checkbox" id="mble" data-ch="mflags">Demo flag A (bit 0)</label><label class="check"><input type="checkbox" id="mwal" data-ch="mflags">Demo flag B (bit 1)</label><span class="mono" id="mflags">00</span><button class="btn sm ghost" data-act="mapply">Use flags as data</button></div>
      <div id="mout" style="margin-top:12px"></div></div>
    <div class="panel"><h3>Schema workbench</h3><p class="small">A decoder is a documented map of bytes, scoped to an exact vendor, model and firmware. Schemas are data, never code.</p>
      <div class="row"><button class="btn sm" data-act="msample" id="msample">Load fictional schema</button><span class="btn sm filebtn">Import schema<input type="file" accept=".json" data-ch="mschema" aria-label="Import schema"></span><button class="btn sm ghost" data-act="mtemplate">Download template</button></div>
      <div class="form"><label class="field">Captured model<input id="mmodel" value="TRAINING-PD"></label><label class="field">Captured firmware<input id="mfw" value="simulated-1.0"></label></div>
      <label class="field">Captured MFG frame<textarea id="mcap" placeholder="Paste a complete MFG frame"></textarea></label>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-act="mdecode" id="mdecode">Decode with schema</button><span class="small muted" id="mschemaName">${S.mfgSchema ? esc(S.mfgSchema.name) : 'No schema loaded'}</span></div><div id="mres"></div></div>
  </div>
  <div class="cards" style="margin-top:16px">${mfgSteps.map(([t, p]) => `<div class="card"><h4 style="margin:0">${esc(t)}</h4><p>${esc(p)}</p></div>`).join('')}</div>
  <div class="panel" style="margin-top:16px"><h3>Assignments</h3><div class="tablewrap"><table class="t"><thead><tr><th>Assignment</th><th>What to do</th><th>Evidence to keep</th></tr></thead><tbody>
    <tr><td>Find the vendor boundary</td><td>Select an MFG frame; locate the 3 OUI bytes, the Command_ID and the opaque rest.</td><td>Original frame and the reader’s PDID.</td></tr>
    <tr><td>Compare two settings</td><td>Capture a baseline and one changed setting; compare them in the classroom.</td><td>Changed offsets plus observed behaviour. A difference alone is not a definition.</td></tr>
    <tr><td>Design a bit field</td><td>Specify masks, valid combinations and reserved bits; test in an emulator.</td><td>Documented masks and expected NAK behaviour.</td></tr>
    <tr><td>Handle a vendor NAK</td><td>Capture request and refusal; check the outer frame first.</td><td>Reason code, exact firmware, expected request layout.</td></tr>
    <tr><td>Prove persistence</td><td>Apply an approved operation through Aether, capture again after a restart.</td><td>The vendor’s persistence statement and before/after captures.</td></tr></tbody></table></div></div>`;
  ACT.mbuild();
}
ACT.mbuild = () => { try { const v = bytes($('mv').value), s = bytes($('ms').value), d = bytes($('md').value); if (v.length !== 3 || s.length !== 1) throw Error('The OUI needs 3 bytes and the Command_ID 1 byte.'); const p = parse(build({ address: 2, command: 0x80, payload: [...v, ...s, ...d] })); mountInspector($('mout'), p, 'mfg'); $('mcap').value = hex(p.b); } catch (e) { $('mout').innerHTML = notice(esc(e.message), 'error'); } };
INP.mflags = () => { $('mflags').textContent = hx(($('mble').checked ? 1 : 0) | ($('mwal').checked ? 2 : 0)); };
ACT.mapply = () => { $('md').value = $('mflags').textContent; ACT.mbuild(); };
ACT.msample = () => { S.mfgSchema = SAMPLE_SCHEMA; $('mschemaName').textContent = SAMPLE_SCHEMA.name; toast('Fictional schema loaded'); };
ACT.mtemplate = () => download('manufacturer-schema-template.json', SAMPLE_SCHEMA);
INP.mschema = async (t) => { try { const s = JSON.parse(await t.files[0].text()); validateSchema(s); S.mfgSchema = s; $('mschemaName').textContent = s.name; toast('Schema loaded — the scope must still match'); } catch (e) { S.mfgSchema = null; toast(e.message); } };
export function validateSchema(s) {
  if (!s || typeof s.name !== 'string' || !/^[0-9a-f]{6}$/i.test(s.vendorHex) || !s.model || !s.firmware || !s.document || !Number.isInteger(s.subcommand) || s.subcommand < 0 || s.subcommand > 255 || !Number.isInteger(s.requestLength) || s.requestLength < 4 || s.requestLength > 1400 || !Array.isArray(s.fields) || s.fields.length > 128)
    throw Error('A schema needs name, vendorHex (6 hex digits), exact model and firmware, document, subcommand, requestLength and fields.');
  for (const f of s.fields) if (!Number.isInteger(f.offset) || f.offset < 4 || !Number.isInteger(f.width) || f.width < 1 || f.width > 4 || f.offset + f.width > s.requestLength || !['hex', 'uint'].includes(f.encoding) || !['big', 'little'].includes(f.endian)) throw Error('Invalid field offset, width, encoding or byte order.');
}
ACT.mdecode = () => {
  const out = $('mres');
  try {
    const s = S.mfgSchema; if (!s) throw Error('Load a schema first.'); validateSchema(s);
    const p = parse($('mcap').value);
    if (!p.ok || p.issues.length) throw Error('Fix the frame’s LEN or check bytes before decoding vendor data.');
    if (p.encrypted) throw Error('Encrypted vendor data cannot be decoded here.');
    if (p.command !== 0x80 || p.reply) throw Error('A request schema needs an MFG (0x80) command from the controller.');
    const d = p.payload;
    if (hex(d.slice(0, 3)).replace(/ /g, '') !== s.vendorHex.toUpperCase()) throw Error('Vendor OUI mismatch — keep the payload opaque.');
    if ($('mmodel').value !== s.model || $('mfw').value !== s.firmware) throw Error('Model/firmware scope mismatch — this schema does not apply.');
    if (d.length !== s.requestLength || d[3] !== s.subcommand) throw Error('Length or Command_ID does not match this schema.');
    const rows = s.fields.map((f) => { const b = d.slice(f.offset, f.offset + f.width); const v = f.encoding === 'hex' ? hex(b) : b.reduce((a, x, i) => a + x * 256 ** (f.endian === 'big' ? b.length - 1 - i : i), 0); return `<tr><td>${esc(f.name)}</td><td class="v">+${f.offset} · ${hex(b)}</td><td>${esc(v)} ${esc(f.unit || '')}</td><td class="small">${esc(f.description || '')}</td></tr>`; }).join('');
    out.innerHTML = notice(`Scoped decode: ${esc(s.name)}<br><span class="small">Source: ${esc(s.document)}</span>`, 'ok') + `<div class="tablewrap"><table class="t"><tbody>${rows}</tbody></table></div><p class="small muted" style="margin-top:8px">A matching schema does not prove the device identity. Replies stay opaque until a reply contract exists.</p>`;
  } catch (e) { out.innerHTML = notice(esc(e.message), 'error'); }
};

// ── Spec reference ────────────────────────────────────────────────────────
function renderReference() {
  $('main').innerHTML = head('Reference · SIA OSDP 2.2.2', 'A definition at every layer.', 'Every command and reply with its fields, the value tables, Annex B capabilities and the behaviour rules the coach uses. Page numbers are the printed pages of the SIA document.') + `
  <div class="panel"><div class="row"><input type="search" id="refq" data-in="refq" placeholder="Search a code, name, field or rule (e.g. 6A, LED, sequence)" style="flex:1"><span class="small muted" id="refn"></span></div>
    <div class="row" style="margin-top:10px">${[['msgs', 'Messages'], ['rules', 'Behaviour rules'], ['caps', 'Capabilities'], ['enums', 'Value tables'], ['frame', 'Frame & security']].map(([k, l]) => `<a class="chip" href="#ref-${k}" style="display:inline-flex;align-items:center;text-decoration:none">${l}</a>`).join('')}</div></div>
  <div id="refBody"></div>`;
  INP.refq();
}
function msgDetails(d, reply) {
  const code = parseInt(d.code, 16), flds = d.record || d.fields || [];
  const exp = reply ? d.inResponseTo : (expectedReplies(short(d.name)) ? [...expectedReplies(short(d.name))].join(', ') + ', NAK or BUSY' : (d.reply || []).map(short).join(', '));
  return `<details class="ref" data-s="${esc(`${hx(code)} ${d.name} ${d.description} ${flds.map((f) => f.name).join(' ')}`.toLowerCase())}"><summary><span class="mono" style="width:30px">${hx(code)}</span><b>${esc(short(d.name))}</b><span class="badge ${reply ? 'info' : ''}">${reply ? 'reply' : 'command'}</span><span class="small muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.description)}</span>${d.deprecated ? '<span class="badge warn">deprecated</span>' : ''}</summary><div>
    <p class="small">${esc(d.description)} <span class="muted">§${esc(String(d.section))}, ${pageRef(d.page)}.</span></p>
    <p class="small"><b>${reply ? 'Answers' : 'Expected reply'}:</b> ${esc(exp || '—')}</p>
    ${d.recordSize ? `<p class="small"><b>Records:</b> ${d.recordSize} bytes each, repeating. ${esc(d.recordNotes || '')}</p>` : ''}
    ${flds.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Offset</th><th>Size</th><th>Field</th><th>Type</th><th>Meaning</th></tr></thead><tbody>${flds.map((f) => `<tr><td class="k">+${f.offset}</td><td class="small">${esc(f.size)}</td><td>${esc(f.name)}</td><td class="small">${esc(f.type)}${f.units ? ` · ${esc(f.units)}` : ''}</td><td class="small">${esc(f.description || '')}${f.values && typeof f.values === 'object' ? `<br><span class="muted">${Object.entries(f.values).map(([k, v]) => `${k} ${v}`).map(esc).join(' · ')}</span>` : ''}${f.enumRef ? ` <span class="muted">(${esc(f.enumRef.replace('enums.', ''))})</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">No DATA field.</p>'}
    ${d.notes ? `<p class="small" style="margin-top:8px">${esc(d.notes)}</p>` : ''}${d.codeConflict ? notice(esc(d.codeConflict), 'warn') : ''}
    ${examplesFor(d).length ? `<p class="small" style="margin-top:8px"><b>Examples from the spec</b></p>${examplesFor(d).map((e) => `<div class="small"><code>${esc(e.bytes)}</code> — ${esc(e.meaning)}</div>`).join('')}` : ''}
    <div class="row" style="margin-top:10px"><button class="btn sm" data-act="refbuild" data-d="${reply ? 'r' : 'c'}" data-c="${code}">Open in builder</button></div></div></details>`;
}
INP.refq = () => {
  const q = ($('refq')?.value || '').toLowerCase().trim();
  const T = TIMING;
  const sections = [
    ['msgs', 'Commands (controller → reader)', SPEC.commands.map((d) => msgDetails(d, false)).join('')],
    ['msgs2', 'Replies (reader → controller)', SPEC.replies.map((d) => msgDetails(d, true)).join('')],
    ['rules', 'Behaviour rules (used by the coach)', SPEC.behaviors.map((b) => `<details class="ref" data-s="${esc(`${b.id} ${b.rule} ${b.anomaly || ''}`.toLowerCase())}"><summary><span class="mono small" style="min-width:170px">${esc(b.id)}</span><span class="small" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.rule)}</span></summary><div><p class="small">${esc(b.rule)} <span class="muted">${pageRef(b.page)}</span></p>${b.anomaly ? `<p class="small"><b>What looks wrong:</b> ${esc(b.anomaly)}</p>` : ''}</div></details>`).join('')],
    ['caps', 'Capabilities (Annex B, osdp_PDCAP)', `<div class="tablewrap"><table class="t"><thead><tr><th>Function</th><th>Compliance levels</th><th>Number of</th></tr></thead><tbody>${Object.entries(EN.pdcapFunctionCodes.codes).map(([k, c]) => `<tr data-s="${esc(`${k} ${c.name} ${c.description}`.toLowerCase())}"><td class="k">${k} · ${esc(c.name)}${c.deprecated ? ' <span class="badge warn">deprecated</span>' : ''}</td><td class="small">${esc(c.description)}<br><span class="muted">${typeof c.compliance === 'object' ? Object.entries(c.compliance).map(([a, b]) => `${a}: ${b}`).map(esc).join('<br>') : esc(c.compliance)}</span></td><td class="small">${esc(typeof c.numberOf === 'object' ? Object.entries(c.numberOf).map(([a, b]) => `${a}: ${b}`).join('; ') : c.numberOf)}</td></tr>`).join('')}</tbody></table></div>`],
    ['enums', 'Value tables', Object.entries(EN).filter(([k]) => k !== 'pdcapFunctionCodes').map(([k, e]) => `<details class="ref" data-s="${esc(`${k} ${JSON.stringify(e.values || e.bits || '')}`.toLowerCase())}"><summary><b class="mono small">${esc(k)}</b><span class="small muted">${esc(e.table || '')} ${pageRef(e.page)}</span></summary><div>${e.values ? `<div class="tablewrap"><table class="t"><tbody>${Object.entries(e.values).map(([a, b]) => `<tr><td class="k">${esc(a)}</td><td class="small">${esc(b)}</td></tr>`).join('')}</tbody></table></div>` : `<pre>${esc(JSON.stringify(e.bits || e.fields || e, null, 1))}</pre>`}${e.note ? `<p class="small" style="margin-top:6px">${esc(e.note)}</p>` : ''}</div></details>`).join('')],
    ['frame', 'Frame, timing & security block', `<div class="tablewrap"><table class="t"><tbody>
      ${SPEC.packet.ctrlBits.map((c) => `<tr data-s="ctrl ${esc(c.name.toLowerCase())}"><td class="k">CTRL ${esc(c.bits)}</td><td class="small">${esc(c.name)}: ${esc(c.description || Object.entries(c.values || {}).map(([k, v]) => `${k} = ${v}`).join('; '))}</td></tr>`).join('')}
      ${[['REPLY_DELAY', `< ${T.REPLY_DELAY_max_ms} ms (typical < ${T.REPLY_DELAY_typical_ms} ms). ${T.REPLY_DELAY_definition}`], ['Inter-character', `${T.interCharacterTimeout_ms} ms. ${T.interCharacterTimeoutNote}`], ['Off-line', T.offlineRule], ['Retries', T.retries], ['Line idle', T.lineIdleBeforeTransmit], ['Mark', T.markBeforeFirstChar], ['Security block', SPEC.packet.securityBlock.structure + '. ' + SPEC.packet.securityBlock.handshakeBlocks], ['SCS_15–18 block', SPEC.packet.securityBlock.sessionBlocks]].map(([a, b]) => `<tr data-s="${esc(`${a} ${b}`.toLowerCase())}"><td class="k">${esc(a)}</td><td class="small">${esc(b)}</td></tr>`).join('')}
      ${SPEC.packet.securityBlock.types.map((t) => `<tr data-s="${esc(`${t.name} ${t.meaning}`.toLowerCase())}"><td class="k">${esc(t.name)} · ${esc(t.value)}</td><td class="small">${esc(t.direction)} — ${esc(t.meaning)}${t.carriedBy ? ` Carried by ${esc(t.carriedBy)}.` : ''}${t.usage ? ` ${esc(t.usage)}` : ''}</td></tr>`).join('')}
    </tbody></table></div>`],
  ];
  $('refBody').innerHTML = sections.map(([id, title, body]) => `<div class="panel" id="ref-${id}" style="margin-top:16px"><h3>${esc(title)}</h3>${body}</div>`).join('');
  let shown = 0, total = 0;
  $('refBody').querySelectorAll('[data-s]').forEach((el) => { total++; const hit = !q || el.dataset.s.includes(q); el.hidden = !hit; if (hit) shown++; if (q && hit && el.tagName === 'DETAILS' && q.length > 2) el.open = true; });
  $('refn').textContent = q ? `${shown} of ${total} entries` : `${total} entries`;
};
ACT.refbuild = (t) => { Object.assign(S.b, { dir: t.dataset.d, code: +t.dataset.c, payload: '', scb: 'none' }); navigate('builder'); };

// ── Aether integration ────────────────────────────────────────────────────
function renderIntegration() {
  const base = liveBase();
  $('main').innerHTML = head('Aether integration', 'Bring the classroom into Aether.', 'Where the Academy lives in Aether, how live mode works, and what the source review found.') + `
  <div class="grid2">
    <div class="panel"><h3>Live from Aether</h3>
      <p>Live mode reads Readers › OSDP Trace on the Pi: one <code>GET /api/osdp/trace/snapshot</code> to find the starting point, then the trace’s own <code>osdp-trace-frame</code> Socket.IO events (falls back to polling the snapshot every 2 s). It never calls a start, send or sniffer endpoint, so the Academy cannot put anything on the bus.</p>
      <div class="stats"><div class="stat"><b>${esc(LIVE.status)}</b><span>Status</span></div><div class="stat"><b>${LIVE.got}</b><span>Frames received</span></div><div class="stat"><b class="mono" style="font-size:13px">${esc(base == null ? 'not set' : base || 'this server')}</b><span>Aether address</span></div></div>
      <label class="field">Aether address (only needed when the Academy is opened from somewhere other than Aether)<input id="apiBase" value="${esc(store.get('academy.api', ''))}" placeholder="http://192.168.1.208:3001"></label>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="apiSave">Save</button><button class="btn sm" data-act="apiTest">Test connection</button><button class="btn sm primary" data-act="live">${LIVE.status === 'off' ? 'Start live' : 'Stop live'}</button></div><div id="apiRes"></div>
      <h4 style="margin-top:16px">What feeds the trace</h4>
      <ul class="small" style="padding-left:18px;color:var(--c2)"><li>Aether’s reader emulation bus (both directions).</li><li>The Controller Emulator’s boards (Update 75 and later).</li><li>The sniffer behind OSDP Trace › Passive capture — see the review finding below before using it on a live panel bus.</li></ul>
      <h4>Imports</h4><p class="small">Trace exports (Readers › OSDP Trace › Export JSON or CSV), saved captures from <code>backend/data/osdp-captures/</code>, Academy evidence files, JSON frame arrays (<code>fullHex</code>, <code>hex</code> or <code>rawHex</code> plus optional <code>ts</code>), the original trace CSV with <code>DataHex</code>/<code>Decode</code>/<code>CommandName</code>, and plain hex lines (prefixes such as timestamps are skipped). Up to 20 MB / 10,000 frames.</p>
    </div>
    <div class="panel"><h3>Where it lives</h3>
      <p>Installed by the Device Firmware update, the Academy is the page <code>frontend/public/osdp-training/</code>, served at <code>/osdp-training/</code> and shown in Aether under <b>Tools › OSDP Academy</b>. It follows Aether’s dark/light theme and needs no internet.</p>
      <p class="small">Launch options: <code>?edition=current</code> (Core Workshop) or <code>?edition=recommended</code> (Field Academy, default); <code>&page=captures</code> and similar open a section directly.</p>
      <h4>Host API (same origin only)</h4>
      <pre>window.AetherOSDPTraining.ingestFrame({ fullHex, ts, port })
window.AetherOSDPTraining.loadCapture([{ fullHex, ts }])
window.AetherOSDPTraining.getEvidence()
iframe.contentWindow.postMessage({ type: 'aether-osdp-frame', frame }, location.origin)</pre>
      <p class="small">The 2.0 React bridge (<code>OSDPTrainingPanel.tsx</code>) is no longer needed: the Academy reads the OSDP Trace itself, which decodes better than the old <code>osdp-sniffer-frame</code> feed.</p>
    </div>
  </div>
  <div class="panel"><h3>Source review — refreshed against pi-sync 2d82965 (2026-10-08)</h3>
    <p class="small">The Pi is newer than that snapshot (Updates 56–84+), so confirm each item on the Pi before acting on it.</p>
    <div class="tablewrap"><table class="t"><thead><tr><th>#</th><th>Finding</th><th>Status</th></tr></thead><tbody>
      <tr><td class="k">1</td><td><b>“Passive capture” transmits.</b> OSDP Trace’s Passive capture calls <code>/api/osdp/sniffer/start</code> with only port and baud, so the sniffer uses its defaults (address 0, poll every 100 ms). Both of its modes send POLLs: tap mode through the emulator’s shared port, open mode on its own port. On a real panel bus that is a second controller. Its own POLLs are never fed to the trace, so the replies they cause look unsolicited. The UI text says “listen-only”.</td><td><span class="badge error">Open</span></td></tr>
      <tr><td class="k">2</td><td>The trace framer accepts the first plausible LEN after any 0x53 and waits for that many bytes; a stray 0x53 in noise can swallow the next real frames. Check the CRC/checksum before accepting a frame and slide one byte on failure.</td><td><span class="badge warn">Open</span></td></tr>
      <tr><td class="k">3</td><td>The trace decoder trusts the security-block length; a value of 0 or 1, or one past the end, misplaces the code. Bound it to 2…frame end.</td><td><span class="badge warn">Open</span></td></tr>
      <tr><td class="k">4</td><td>Sniffer traffic is fed to the trace as direction “rx” for every frame. Direction should come from ADDR bit 7 (the decoder already does this for display; exports still say rx).</td><td><span class="badge info">Minor</span></td></tr>
      <tr><td class="k">5</td><td>Old findings now handled by the trace path: fixed command offset 5, missing CRC check, 256-byte limit (now 1,440), replies counted as sequence increments.</td><td><span class="badge ok">Fixed in trace</span></td></tr>
      <tr><td class="k">6</td><td>The legacy <code>osdp-sniffer-frame</code> decoder (<code>OSDPSniffer._parseFrame</code>) still has those old limits, and its LED gloss shows only one of the temporary/permanent parts. <code>OSDPSnifferTool</code> renders it (<code>OSDPSection</code> also subscribes but does not show it).</td><td><span class="badge info">Legacy</span></td></tr>
    </tbody></table></div></div>
  <div class="panel"><h3>What is validated and what remains</h3><p class="small">Unit tests (27 + 21 groups) cover the Annex E CRC/checksum vectors, the Annex E Secure Channel frames, direction-aware codes, security-block and MAC boundaries, every spec example and every scenario’s expected coach findings. A DOM test drives every page; browser screenshots cover dark and light at desktop and phone widths. Physical-reader behaviour, real Secure Channel sessions and vendor semantics must still be validated with real captures and vendor documents. This is a training tool, not a conformance-certified OSDP stack.</p></div>`;
}
ACT.apiSave = () => { let v = $('apiBase').value.trim(); if (v) { try { const u = new URL(v); if (!/^https?:$/.test(u.protocol) || u.pathname.length > 1 || u.search || u.hash) throw 0; v = u.origin; } catch { toast('Use a plain address such as http://192.168.1.208:3001'); return; } } store.set('academy.api', v); toast(v ? 'Saved' : 'Cleared — using this server'); renderIntegration(); };
ACT.apiTest = async () => { const base = liveBase(); const el = $('apiRes'); if (base == null) { el.innerHTML = notice('No Aether address — set one above.', 'warn'); return; } el.innerHTML = notice('Testing…'); try { const r = await fetch(`${base}/api/osdp/trace/snapshot?since=2147483647`, { cache: 'no-store' }); const j = await r.json(); el.innerHTML = notice(`Reached Aether’s OSDP Trace (source: ${esc(j.source)}, ${esc(j.lastId)} frames so far).`, 'ok'); } catch (e) { el.innerHTML = notice(`Could not reach ${esc(base || 'this server')}: ${esc(e.message)}`, 'error'); } };

const PAGE_RENDER = { overview, lessons: renderLessons, builder: renderBuilder, captures: renderCaptures, faults: renderFaults, bits: renderBits, quiz: renderQuiz, manufacturer: renderMfg, reference: renderReference, integration: renderIntegration };
render();
