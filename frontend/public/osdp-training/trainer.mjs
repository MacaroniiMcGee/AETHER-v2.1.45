// AETHER OSDP Academy — training engine (Practice · Assessment · Final practical · Mastery).
//
// Progress lives in progress.train (localStorage via the app):
//   q[`${id}@${v}`]  { n, ok, first, hints, wrongs, last }        — per stored question VERSION
//   skills[skill]    { n, ok, firstN, firstOk, recent[], variantsOk, evN, evOk }
//   review[]         { skill, qid?, gen?, dueN, dueAt }           — delayed review queue
//   assessments[]    { at, size, correct, pct, passed, bySkill, levels }
//   practical        { at, correct, total, passed }
//   settings         { threshold, size, evidenceInAssessment, varRatio }
// Ids are stable, so reordering or adding questions never moves anyone's record.

import { parse, hex } from './protocol.mjs?v=198dc99a';
import { questions, byId, key, grade, gradeEvidence, expectedText, SKILLS, STAGES, levels, LEGACY_ORDER } from './questions.mjs?v=198dc99a';
import { variantFor, GENERATORS, BY_SKILL } from './generators.mjs?v=198dc99a';
import { practical } from './practical.mjs?v=198dc99a';

const DEF_SETTINGS = { threshold: 90, size: 20, evidenceInAssessment: true, varRatio: 40 };
const REVIEW_AFTER_N = 3;                      // questions later in this session
const REVIEW_AFTER_MS = 20 * 3600 * 1000;      // and again on a later visit
const RECENT = 12;
const SESSION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// due later in THIS session (question count), or on a later visit (time)
const isDue = (x, sessionN, now = Date.now()) => (x.sess === SESSION && x.dueN <= sessionN) || x.dueAt <= now;
const SKILL_HINT = {
  'number-base': 'Each hex digit is four bits. Multiply the first digit by 16 and add the second.',
  'byte-count': 'Count pairs of hex digits. For an inclusive range, last − first + 1.',
  endianness: 'Little-endian: the FIRST byte is the LOW byte. value = first + 256 × second.',
  'bit-ops': 'Bit n is worth 2ⁿ. Set with OR, clear with AND NOT.',
  layers: 'Ask which layer each number belongs to: wire (RS-485), message (OSDP), network (IP) or application (doors).',
  'evidence-limits': 'Separate what the bytes show from what you infer. A message being reported is not the decision being made.',
  'addr-byte': 'Bit 7 says direction (set = reply). Bits 0–6 are the address: AND with 0x7F.',
  'ctrl-byte': 'CTRL bits 0–1 = sequence, bit 2 = CRC (1) or checksum (0), bit 3 = security block follows.',
  length: 'LEN counts SOM through the last check byte (not a leading FF). Header is 5 bytes, code 1, CRC 2 / checksum 1.',
  'scb-offsets': 'If CTRL bit 3 is set, offset 5 is the security block length; the code comes right after the block.',
  framing: 'Trust LEN and the check bytes first; only then interpret the content.',
  construct: 'SOM · ADDR · LEN low · LEN high · CTRL · code · data · check. The Frame builder can calculate the CRC.',
  sequence: 'SQN cycles 1, 2, 3, 1… per reader (per port + address). A reply echoes its command’s SQN. 0 means restart.',
  pairing: 'Every command gets one reply. Check the expected-reply map: e.g. OUT → ACK or OSTATR.',
  'file-transfer': 'FILETRANSFER: type, total (4), offset (4), fragment size (2), data. FTSTAT: action, delay (2), signed status (2), max (2).',
  secure: 'Four steps: CHLNG → CCRYPT → SCRYPT → RMAC_I. Observing an exchange is not verifying it.',
  keys: 'The base key (SCBK) establishes sessions; session keys protect one session. Defaults are public.',
  timing: '8N1 = 10 bits per byte. Turnaround is measured from the command’s last byte to the reply’s first byte.',
  capture: 'Where was the capture taken, what can it hear, and does it transmit?',
  vendor: 'DATA offsets start after the code. Three vendor bytes, then the subcommand. Scope = vendor + model + firmware + document.',
  'io-states': 'One byte per input: 00 Normal, 01 Active, 02 Trouble, 03 Shorted — only when its validity bit is set.',
  support: 'Escalate with the original bytes and enough context for someone else to reproduce it.',
};

// ── progress model ─────────────────────────────────────────────────────────
export function trainState(progress) {
  const t = progress.train || (progress.train = { v: 3, q: {}, skills: {}, review: [], assessments: [], practical: null, settings: { ...DEF_SETTINGS } });
  t.settings = { ...DEF_SETTINGS, ...(t.settings || {}) };
  t.q ||= {}; t.skills ||= {}; t.review ||= []; t.assessments ||= [];
  // one-time migration: v2.1 stored { answers: { arrayIndex: true } }
  if (!t.migrated && progress.answers && Object.keys(progress.answers).length) {
    for (const [i, ok] of Object.entries(progress.answers)) {
      const id = LEGACY_ORDER[+i]; if (!id || !ok) continue;
      t.q[`${id}@1`] ||= { n: 1, ok: 1, first: null, hints: 0, wrongs: 0, last: 0, legacy: true };
    }
    t.migrated = true;
  }
  return t;
}
const skillRec = (t, s) => (t.skills[s] ||= { n: 0, ok: 0, firstN: 0, firstOk: 0, recent: [], variantsOk: 0, evN: 0, evOk: 0 });

/** Record one graded attempt. first = this was the learner's first attempt at this item in this run. */
export function recordAttempt(t, q, ok, { first = true, hinted = false, now = Date.now(), sessionN = 0 } = {}) {
  if (!q.generated) {
    const r = (t.q[key(q)] ||= { n: 0, ok: 0, first: null, hints: 0, wrongs: 0, last: 0 });
    r.n++; if (ok) r.ok++; else r.wrongs++; if (hinted) r.hints++; r.last = now;
    if (r.first == null && first) r.first = ok && !hinted;
  }
  for (const s of q.skills) {
    const r = skillRec(t, s);
    r.n++; if (ok) r.ok++;
    if (first) { r.firstN++; if (ok && !hinted) r.firstOk++; }
    r.recent.push(ok && !hinted ? 1 : 0); if (r.recent.length > RECENT) r.recent.shift();
    if (q.generated && ok) r.variantsOk++;
  }
  // delayed review: wrong → schedule; right on a review item → clear it
  if (!ok) {
    for (const s of q.skills.slice(0, 2)) {
      const ex = t.review.find((x) => x.skill === s);
      const item = { skill: s, qid: q.generated ? null : q.id, gen: q.gen || null, dueN: sessionN + REVIEW_AFTER_N, dueAt: now + REVIEW_AFTER_MS, sess: SESSION };
      if (ex) Object.assign(ex, item); else t.review.push(item);
    }
  } else t.review = t.review.filter((x) => !(q.skills.includes(x.skill) && (q.generated || q.reviewOf === x.skill || x.qid === q.id) && isDue(x, sessionN, now)));
}
export function recordEvidence(t, q, ok) { for (const s of q.skills) { const r = skillRec(t, s); r.evN++; if (ok) r.evOk++; } }

export function mastery(t, s) {
  const r = t.skills[s];
  if (!r || !r.n) return { status: 'new', pct: null, r };
  const recent = r.recent.length ? Math.round((r.recent.reduce((a, x) => a + x, 0) / r.recent.length) * 100) : null;
  const due = t.review.some((x) => x.skill === s);
  const hasGen = !!BY_SKILL[s];
  const mastered = r.recent.length >= 5 && recent >= t.settings.threshold && (!hasGen || r.variantsOk > 0) && !due;
  return { status: mastered ? 'mastered' : due ? 'review' : 'practising', pct: recent, r, due };
}
export function overallMastery(t) {
  const best = t.assessments.reduce((m, a) => Math.max(m, a.pct), 0);
  const passed = t.assessments.some((a) => a.passed && a.levels?.length === 5);
  return { bestAssessment: best, assessmentPassed: passed, practicalPassed: !!t.practical?.passed, mastered: passed && !!t.practical?.passed };
}

/** Choose the next practice item. */
export function nextPractice(t, { level = 0, skill = '', sessionN = 0, now = Date.now(), seed = Date.now(), seen = new Set() } = {}) {
  const inScope = (q) => (!level || q.level === level) && (!skill || q.skills.includes(skill));
  // 1. due review — a different question testing the same skill
  const due = t.review.filter((x) => (!skill || x.skill === skill) && isDue(x, sessionN, now));
  for (const d of due) {
    const v = variantFor(d.gen && GENERATORS[d.gen] ? d.gen : d.skill, seed);
    if (v) return { q: { ...v, reviewOf: d.skill }, review: d.skill };
    const alt = questions.filter((q) => q.skills.includes(d.skill) && q.id !== d.qid && !seen.has(q.id));
    if (alt.length) return { q: { ...pickBy(alt, seed), reviewOf: d.skill }, review: d.skill };
  }
  const pool = questions.filter(inScope);
  if (!pool.length) return null;
  // 2. sometimes a fresh generated variant of an in-scope skill
  const r = mulberry(seed);
  if (r() * 100 < t.settings.varRatio * 0.6) {
    const skills = (skill ? [skill] : [...new Set(pool.flatMap((q) => q.skills))]).filter((s) => BY_SKILL[s]);
    if (skills.length) { const v = variantFor(skills[Math.floor(r() * skills.length)], seed + 1); if (v && (!level || v.level === level) && (!skill || v.skills.includes(skill))) return { q: v }; }
  }
  // 3. never-correct first, then last-wrong, then the rest — skipping ones seen this session
  const score = (q) => { const rec = t.q[key(q)]; return !rec ? 0 : !rec.ok ? 1 : rec.wrongs > rec.ok ? 2 : 3; };
  const fresh = pool.filter((q) => !seen.has(q.id));
  const list = fresh.length ? fresh : pool;
  const min = Math.min(...list.map(score));
  return { q: pickBy(list.filter((q) => score(q) === min), seed) };
}
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const pickBy = (arr, seed) => arr[Math.floor(mulberry(seed)() * arr.length)];

/** A fresh assessment set: spread over the chosen levels and skills; part static, part generated. */
export function buildAssessment(t, { levels: lv = [1, 2, 3, 4, 5], size, seed = Date.now() } = {}) {
  const n = size || t.settings.size, r = mulberry(seed);
  const lastIds = new Set((t.assessments.at(-1)?.items || []).map((x) => x.id));
  const pool = questions.filter((q) => lv.includes(q.level) && !lastIds.has(q.id));
  const items = [], used = new Set();
  const nGen = Math.round(n * t.settings.varRatio / 100);
  const skills = [...new Set(pool.flatMap((q) => q.skills))].filter((s) => BY_SKILL[s]);
  for (let i = 0; i < nGen && skills.length; i++) { const v = variantFor(skills[Math.floor(r() * skills.length)], Math.floor(r() * 2 ** 31)); if (v && lv.includes(v.level)) items.push(v); }
  // round-robin over levels for the static part
  const byLevel = lv.map((l) => pool.filter((q) => q.level === l).sort(() => r() - 0.5));
  let li = 0;
  while (items.length < n && byLevel.some((x) => x.length)) { const L = byLevel[li++ % byLevel.length]; const q = L.shift(); if (q && !used.has(q.id)) { used.add(q.id); items.push(q); } }
  return items.sort(() => r() - 0.5).slice(0, n);
}
export function scoreAssessment(t, items, answers, evid, { now = Date.now(), lv = [1, 2, 3, 4, 5] } = {}) {
  let correct = 0; const bySkill = {}, detail = [];
  items.forEach((q, i) => {
    let ok = q.kind === 'evidence-only' ? false : grade(q, answers[i]).ok;
    let evOk = null;
    if (q.evidence && (t.settings.evidenceInAssessment || q.kind === 'evidence-only')) { evOk = gradeEvidence(q, evid[i] || []).ok; if (q.kind === 'evidence-only') ok = evOk; }
    const full = ok && (evOk !== false || q.kind === 'evidence-only');
    if (full) correct++;
    recordAttempt(t, q, full, { first: true, now });
    if (evOk != null && q.kind !== 'evidence-only') recordEvidence(t, q, evOk);
    for (const s of q.skills) { const b = (bySkill[s] ||= { n: 0, ok: 0 }); b.n++; if (full) b.ok++; }
    detail.push({ ok: full, answerOk: ok, evOk });
  });
  const pct = Math.round((correct / items.length) * 100);
  const rec = { at: now, size: items.length, correct, pct, passed: pct >= t.settings.threshold, bySkill, levels: lv, items: items.map((q) => ({ id: q.id, gen: q.gen || null })) };
  t.assessments.push(rec); if (t.assessments.length > 30) t.assessments.shift();
  return { ...rec, detail };
}

// ── UI ─────────────────────────────────────────────────────────────────────
const hx2 = (n) => (n & 255).toString(16).toUpperCase().padStart(2, '0');
const U = { tab: 'practice', level: 0, skill: '', sessionN: 0, seen: new Set(), cur: null, answered: null, input: '', hinted: false, picks: [], evDone: null,
  asmt: null, prac: null, firstTry: true };

export function renderTrainer(ctx) {
  const t = trainState(ctx.progress);
  const { esc, head } = ctx;
  const tabs = [['practice', 'Practice'], ['assess', 'Assessment'], ['practical', 'Final practical'], ['mastery', 'Mastery'], ['settings', 'Instructor']];
  const due = t.review.filter((x) => isDue(x, U.sessionN)).length;
  ctx.main.innerHTML = head('Field Academy · training', 'Recognise, calculate, construct, investigate, explain.',
    `${questions.length} questions in five sections, generated variants, evidence you click in real frames, and mastery tracked per skill.`) + `
    <div class="btngroup" role="tablist" aria-label="Training">${tabs.map(([k, l]) => `<button data-tr="tab" data-k="${k}" aria-pressed="${U.tab === k}">${l}${k === 'practice' && due ? ` <span class="badge warn">${due} review</span>` : ''}</button>`).join('')}</div>
    <div id="trBody" style="margin-top:16px"></div>`;
  ({ practice, assess, practical: practicalTab, mastery: masteryTab, settings: settingsTab })[U.tab](ctx, t);
  bind(ctx, t);
}

// frame rows used by questions (blind until answered)
function framesHTML(ctx, q, { reveal, picks = [], evidence = null, pickable = false, idx = '' }) {
  if (!q.frames?.length) return '';
  const want = new Set((q.evidence?.pick || []).map(([f, o]) => `${f}:${o}`));
  const sel = new Set(picks.map(([f, o]) => `${f}:${o}`));
  return `${q.headerOnly ? '<div class="badge warn" style="margin-bottom:6px">Header only — not a validated packet</div>' : ''}${q.frames.map((fr, fi) => {
    let p = null; try { p = parse(fr.hex); } catch { /* shown raw */ }
    const bytes = fr.hex.split(' ');
    return `<div class="trframe"><div class="small muted">${fi + 1} · ${ctx.esc(fr.label || 'frame')}${reveal && p ? ` — <b>${ctx.esc(p.name)}</b> ${p.reply ? 'reply from' : 'to'} ${p.address}, SQN ${p.sequence}` : ''}</div>
      <div class="bytes" role="group" aria-label="Frame ${fi + 1} bytes">${bytes.map((b, o) => {
        const k = `${fi}:${o}`;
        const cls = evidence ? (want.has(k) && sel.has(k) ? 'ev-ok' : want.has(k) ? 'ev-miss' : sel.has(k) ? 'ev-extra' : '') : sel.has(k) ? 'pick' : '';
        const f = p?.fields?.[o];
        return `<button class="byte ${reveal && p && f ? ctx.kindOf(f, p) : 'k-blind'} ${cls}" ${pickable ? `data-tr="pick" data-f="${fi}" data-o="${o}"` : 'tabindex="-1"'} aria-pressed="${sel.has(k)}" title="offset ${o}${reveal && f ? ' · ' + ctx.esc(f.name) : ''}">${b}<small>${reveal && f ? ctx.esc(f.name) : `+${o}`}</small></button>`;
      }).join('')}</div></div>`;
  }).join('')}`;
}

function answerHTML(ctx, q, { locked, picked, input, result, name = 'ans' }) {
  const { esc } = ctx;
  if (q.kind === 'choice') return q.options.map((a, i) => `<button class="answer ${result ? (i === q.answer ? 'right' : i === picked ? 'wrong' : '') : picked === i ? 'chosen' : ''}" data-tr="choose" data-i="${i}" ${locked ? 'aria-disabled="true"' : ''}><span class="key">${String.fromCharCode(65 + i)}</span>${esc(a)}</button>`).join('');
  if (q.kind === 'value') return `<div class="row"><input class="mono" id="trIn" data-tr-in="${name}" value="${esc(input || '')}" ${locked ? 'disabled' : ''} placeholder="${q.accept[0].t === 'hex' ? 'e.g. 3F or 0x3F' : q.accept[0].t === 'bytes' ? 'e.g. 1A 00' : q.accept[0].t === 'bin' ? '8 bits, e.g. 00101100' : q.accept[0].t === 'num' ? 'number, e.g. 12.5' : 'number'}" aria-label="Your answer" style="max-width:260px"></div>`;
  if (q.kind === 'frame') return `<textarea class="mono" id="trIn" data-tr-in="${name}" rows="2" ${locked ? 'disabled' : ''} placeholder="53 …" aria-label="Your frame in hex" style="width:100%">${esc(input || '')}</textarea>${result?.detail ? frameGradeHTML(ctx, result.detail) : ''}`;
  return '';
}
function frameGradeHTML(ctx, g) {
  return `<div class="tablewrap" style="margin-top:8px"><table class="t"><thead><tr><th>Field</th><th>Expected</th><th>Yours</th><th></th></tr></thead><tbody>${g.groups.map((x) => `<tr><td class="k">${ctx.esc(x.name)}</td><td class="v">${ctx.esc(x.want.join(' '))}</td><td class="v">${ctx.esc(x.got.join(' '))}</td><td>${x.ok ? '<span class="badge ok">ok</span>' : '<span class="badge error">fix</span>'}</td></tr>`).join('')}</tbody></table></div>${g.extra ? `<p class="small">${g.extra} extra byte(s) after the frame.</p>` : ''}`;
}

// ── Practice ───────────────────────────────────────────────────────────────
function practice(ctx, t) {
  const { esc, notice } = ctx;
  if (!U.cur) newPractice(t);
  const c = U.cur;
  const body = document.getElementById('trBody');
  if (!c) { body.innerHTML = notice('No questions match this filter.'); return; }
  const q = c.q, res = U.answered;
  const skillOpts = Object.entries(SKILLS).map(([k, l]) => `<option value="${k}" ${U.skill === k ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const needEv = q.evidence && (q.kind === 'evidence-only' || res);
  body.innerHTML = `<div class="row" style="gap:10px;flex-wrap:wrap">
      <div class="btngroup" role="group" aria-label="Section"><button data-tr="level" data-l="0" aria-pressed="${!U.level}">Mixed</button>${levels.map((l, i) => `<button data-tr="level" data-l="${i + 1}" aria-pressed="${U.level === i + 1}">${i + 1} · ${esc(l)}</button>`).join('')}</div>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px">Skill <select data-tr-ch="skill" style="width:auto"><option value="">All skills</option>${skillOpts}</select></label></div>
    <div class="grid2" style="margin-top:12px">
      <div class="panel">
        <div class="row between"><div class="row">${c.review ? `<span class="badge warn">Review · ${esc(SKILLS[c.review])}</span>` : ''}${q.generated ? '<span class="badge brand">Generated variant</span>' : `<span class="badge">Section ${q.level} · ${esc(q.id)}</span>`}<span class="badge">${esc(q.stage)}</span></div>
          <span class="small muted">${q.skills.map((s) => esc(SKILLS[s])).join(' · ')}</span></div>
        <h2 style="margin-top:12px">${esc(q.q)}</h2>
        ${framesHTML(ctx, q, { reveal: !!res, picks: U.picks, evidence: U.evDone, pickable: needEv && !U.evDone })}
        ${q.kind !== 'evidence-only' ? answerHTML(ctx, q, { locked: !!res, picked: U.picked, input: U.input, result: res }) : ''}
        ${needEv && !U.evDone ? `<div class="notice"><div><b>Show your evidence.</b> ${esc(q.evidence.prompt)} <span class="muted">(${U.picks.length} selected)</span></div></div>` : ''}
        <div class="row" style="margin-top:10px">
          ${!res && q.kind !== 'evidence-only' ? `<button class="btn primary" data-tr="check">Check</button><button class="btn ghost" data-tr="hint" ${U.hinted ? 'disabled' : ''}>Hint</button>` : ''}
          ${needEv && !U.evDone ? '<button class="btn primary" data-tr="evcheck">Check evidence</button>' : ''}
          ${res || U.evDone ? `<button class="btn ${needEv && !U.evDone ? 'ghost' : 'primary'}" data-tr="next">Next →</button>` : ''}
          ${res && !res.ok ? '<button class="btn" data-tr="variant">Try a variant of this</button>' : ''}</div>
        ${U.hinted && !res ? notice(`<b>Hint.</b> ${esc(q.hint || SKILL_HINT[q.skills[0]] || '')}`) : ''}
        ${res ? feedbackHTML(ctx, q, res) : ''}
        ${U.evDone ? notice(U.evDone.ok ? '<b>Evidence correct.</b> Those are the bytes that support the answer.' : `<b>Evidence incomplete.</b> ${U.evDone.missing.length ? `Missing ${U.evDone.missing.length} byte(s) (outlined). ` : ''}${U.evDone.extra.length ? `${U.evDone.extra.length} selected byte(s) don’t support it (red). ` : ''}${esc(q.why)}`, U.evDone.ok ? 'ok' : 'warn') : ''}
      </div>
      <div class="panel">${sidePanel(ctx, t)}</div>
    </div>`;
  if (!res) setTimeout(() => document.getElementById('trIn')?.focus(), 0);
}
function feedbackHTML(ctx, q, res) {
  const { esc, notice } = ctx;
  if (res.ok) return notice(`<b>Correct.</b> ${esc(q.why)}`, 'ok');
  return notice(`<b>Not quite.</b> The answer is <span class="mono">${esc(expectedText(q))}</span>. ${esc(q.why)}
    ${q.frames?.length && q.evidence ? '<br><span class="small">The relevant bytes are outlined above once you check your evidence.</span>' : ''}
    <br><span class="small">This skill comes back for review in a few questions and on your next visit.</span>`, 'warn');
}
function sidePanel(ctx, t) {
  const { esc } = ctx;
  const due = t.review.filter((x) => isDue(x, U.sessionN));
  const weakest = Object.keys(SKILLS).map((s) => [s, mastery(t, s)]).filter(([, m]) => m.status !== 'new' && m.status !== 'mastered').sort((a, b) => (a[1].pct ?? 0) - (b[1].pct ?? 0)).slice(0, 5);
  return `<h3>This session</h3><p class="small">${U.sessionN} answered${due.length ? ` · ${due.length} skill${due.length === 1 ? '' : 's'} due for review` : ''}.</p>
    ${weakest.length ? `<h4>Focus next</h4>${weakest.map(([s, m]) => `<div class="small" style="margin:6px 0 3px">${esc(SKILLS[s])} — ${m.pct ?? 0}%${m.due ? ' · review due' : ''}</div><div class="bar"><i style="width:${m.pct ?? 0}%"></i></div>`).join('')}` : '<p class="small muted">Answer a few questions to see which skills need work.</p>'}
    <hr><p class="small">Each section follows the same cycle: <b>recognise</b> a field, <b>calculate</b> its value, <b>construct</b> a message, <b>investigate</b> a capture, <b>explain</b> what the evidence establishes and what remains uncertain.</p>
    <p class="small muted">Questions with frames start blind: byte names appear after you answer.</p>`;
}
function newPractice(t) {
  U.answered = null; U.input = ''; U.picked = null; U.hinted = false; U.picks = []; U.evDone = null;
  U.cur = nextPractice(t, { level: U.level, skill: U.skill, sessionN: U.sessionN, seed: (Math.random() * 2 ** 31) >>> 0, seen: U.seen });
}

// ── Assessment ─────────────────────────────────────────────────────────────
function assess(ctx, t) {
  const { esc, notice } = ctx;
  const body = document.getElementById('trBody');
  const A = U.asmt;
  if (!A) {
    const last = t.assessments.at(-1);
    body.innerHTML = `<div class="grid2"><div class="panel"><h3>Assessment</h3>
      <p>A fresh set of ${t.settings.size} questions (${t.settings.varRatio}% generated variants, no repeats from your last set). No hints and no feedback until you submit; then every answer is explained.</p>
      <p class="small">Pass mark: <b>${t.settings.threshold}%</b> on a fresh set. Mastery also needs the final practical.</p>
      <div class="row" style="flex-wrap:wrap">${levels.map((l, i) => `<label class="chip"><input type="checkbox" data-tr-lv="${i + 1}" checked> ${i + 1} · ${esc(l)}</label>`).join('')}</div>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-tr="astart">Start assessment</button></div></div>
      <div class="panel"><h3>History</h3>${t.assessments.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>When</th><th>Score</th><th>Sections</th><th></th></tr></thead><tbody>${t.assessments.slice().reverse().slice(0, 10).map((a) => `<tr><td>${new Date(a.at).toLocaleString()}</td><td class="v">${a.correct}/${a.size} · ${a.pct}%</td><td>${(a.levels || []).join(', ')}</td><td>${a.passed ? '<span class="badge ok">pass</span>' : '<span class="badge warn">below</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No assessments yet.</p>'}
      ${last ? `<p class="small">Last: ${last.pct}%.</p>` : ''}</div></div>`;
    return;
  }
  if (A.result) {
    const R = A.result;
    body.innerHTML = `<div class="panel"><div class="row between"><h3 style="margin:0">Result: ${R.correct}/${R.size} · ${R.pct}%</h3>${R.passed ? '<span class="badge ok">Pass</span>' : `<span class="badge warn">Below ${t.settings.threshold}%</span>`}</div>
      <div class="tablewrap" style="margin-top:10px"><table class="t"><thead><tr><th>Skill</th><th>Score</th></tr></thead><tbody>${Object.entries(R.bySkill).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n).map(([s, b]) => `<tr><td>${esc(SKILLS[s])}</td><td class="v">${b.ok}/${b.n}</td></tr>`).join('')}</tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-tr="anew">New assessment</button><button class="btn" data-tr="tab" data-k="practice">Practise weak skills</button></div></div>
      ${A.items.map((q, i) => { const d = R.detail[i]; return `<div class="panel" style="margin-top:10px"><div class="row between"><span class="badge">${i + 1} · ${q.generated ? 'variant' : esc(q.id)}</span>${d.ok ? '<span class="badge ok">correct</span>' : '<span class="badge error">incorrect</span>'}</div>
        <p style="margin:8px 0"><b>${esc(q.q)}</b></p>${framesHTML(ctx, q, { reveal: true, picks: A.ev[i] || [], evidence: q.evidence ? {} : null })}
        <p class="small">Your answer: <span class="mono">${esc(q.kind === 'choice' ? (q.options[A.ans[i]] ?? '—') : q.kind === 'evidence-only' ? `${(A.ev[i] || []).length} byte(s)` : (A.ans[i] || '—'))}</span>${q.kind !== 'evidence-only' ? ` · correct: <span class="mono">${esc(expectedText(q))}</span>` : ''}${d.evOk === false ? ' · evidence incomplete' : ''}</p>
        ${q.kind === 'frame' && A.ans[i] ? frameGradeHTML(ctx, grade(q, A.ans[i]).detail) : ''}<p class="small muted">${esc(q.why)}</p></div>`; }).join('')}`;
    return;
  }
  const i = A.i, q = A.items[i];
  body.innerHTML = `<div class="panel"><div class="row between"><span class="badge">Question ${i + 1} of ${A.items.length}</span><span class="small muted">${A.items.filter((_, k) => A.ans[k] != null && A.ans[k] !== '' || (A.ev[k] || []).length).length} answered</span></div>
    <h2 style="margin-top:12px">${esc(q.q)}</h2>
    ${framesHTML(ctx, q, { reveal: false, picks: A.ev[i] || [], pickable: !!q.evidence && (t.settings.evidenceInAssessment || q.kind === 'evidence-only') })}
    ${q.evidence && (t.settings.evidenceInAssessment || q.kind === 'evidence-only') ? `<p class="small"><b>Evidence:</b> ${esc(q.evidence.prompt)}</p>` : ''}
    ${q.kind !== 'evidence-only' ? answerHTML(ctx, q, { locked: false, picked: A.ans[i], input: typeof A.ans[i] === 'string' ? A.ans[i] : '', name: 'asm' }) : ''}
    <div class="row" style="margin-top:12px"><button class="btn" data-tr="aprev" ${i === 0 ? 'disabled' : ''}>← Back</button>${i < A.items.length - 1 ? '<button class="btn primary" data-tr="anext">Next →</button>' : '<button class="btn primary" data-tr="asubmit">Submit assessment</button>'}<button class="btn ghost" data-tr="aquit">Abandon</button></div></div>`;
}

// ── Final practical ────────────────────────────────────────────────────────
function practicalTab(ctx, t) {
  const { esc, notice } = ctx;
  const body = document.getElementById('trBody');
  const P = U.prac || (U.prac = { ans: {}, ev: {}, done: false });
  const tasks = practical.tasks;
  body.innerHTML = `<div class="grid2"><div class="panel"><h3>${esc(practical.title)}</h3><p>${esc(practical.brief)}</p>
      ${notice('Simulated capture — constructed for training, not observed hardware behaviour. Names stay hidden until you submit.')}
      <div class="trframes">${framesHTML(ctx, { frames: practical.frames }, { reveal: P.done, picks: [] })}</div></div>
    <div class="panel"><h3>Tasks</h3>${tasks.map((q, i) => `<div class="task"><p><b>${i + 1}.</b> ${esc(q.q)}</p>
      ${q.kind === 'choice' ? q.options.map((o, k) => `<label class="chip ${P.done ? (P.passed && k === q.answer ? 'right' : P.ans[i] === k ? (P.res[i] ? 'right' : 'wrong') : '') : ''}"><input type="radio" name="pt${i}" data-tr-pt="${i}" value="${k}" ${P.ans[i] === k ? 'checked' : ''} ${P.done ? 'disabled' : ''}> ${esc(o)}</label>`).join('')
        : `<input class="mono" data-tr-pv="${i}" value="${esc(P.ans[i] ?? '')}" ${P.done ? 'disabled' : ''} style="max-width:220px">`}
      ${P.done ? `<p class="small ${P.res[i] ? '' : 'muted'}">${P.res[i] ? '✓ Correct' : '✗ Not correct'}${P.passed ? ` — ${esc(q.why)}` : ''}</p>` : ''}</div>`).join('')}
      ${P.done && !P.passed ? notice('Answers and explanations stay hidden until you pass, so the practical still tests you next time. Practise the skills behind the ✗ tasks, then try again.', 'warn') : ''}
      <div class="row">${P.done ? `<b>${P.score}/${tasks.length}</b>${P.passed ? '<span class="badge ok">Practical passed</span>' : `<span class="badge warn">Needs ${Math.ceil(tasks.length * t.settings.threshold / 100)}</span>`}<button class="btn" data-tr="preset">Try again</button>` : '<button class="btn primary" data-tr="psubmit">Submit practical</button>'}</div></div></div>`;
}

// ── Mastery ────────────────────────────────────────────────────────────────
function masteryTab(ctx, t) {
  const { esc } = ctx;
  const o = overallMastery(t);
  const rows = Object.keys(SKILLS).map((s) => { const m = mastery(t, s); const r = m.r || {}; return `<tr><td>${esc(SKILLS[s])}</td><td class="v">${r.n || 0}</td><td class="v">${r.firstN ? Math.round((r.firstOk / r.firstN) * 100) + '%' : '—'}</td><td class="v">${m.pct == null ? '—' : m.pct + '%'}</td><td class="v">${r.variantsOk || 0}</td><td class="v">${r.evN ? `${r.evOk}/${r.evN}` : '—'}</td><td>${m.status === 'mastered' ? '<span class="badge ok">mastered</span>' : m.status === 'review' ? '<span class="badge warn">review due</span>' : m.status === 'new' ? '<span class="badge">new</span>' : '<span class="badge info">practising</span>'}</td><td><button class="btn sm" data-tr="drill" data-s="${s}">Drill</button></td></tr>`; }).join('');
  const stats = questions.reduce((m, q) => { const r = t.q[key(q)]; if (r) { m.tried++; if (r.ok) m.ok++; if (r.first === true) m.first++; m.hints += r.hints; m.rep += r.wrongs > 1 ? 1 : 0; } return m; }, { tried: 0, ok: 0, first: 0, hints: 0, rep: 0 });
  document.getElementById('trBody').innerHTML = `<div class="cards">
      <div class="card"><span class="eyebrow">Mastery rule</span><div class="num">${o.mastered ? 'Met' : 'Not yet'}</div><p>${t.settings.threshold}% on a fresh all-section assessment (best ${o.bestAssessment}%) ${o.assessmentPassed ? '✓' : '✗'} · final practical ${o.practicalPassed ? '✓' : '✗'}</p></div>
      <div class="card"><span class="eyebrow">Questions</span><div class="num">${stats.ok}/${questions.length}</div><p>${stats.tried} attempted · ${stats.first} right first time · ${stats.hints} hints · ${stats.rep} missed more than once</p></div>
      <div class="card"><span class="eyebrow">Review queue</span><div class="num">${t.review.length}</div><p>Missed skills come back later in the session and on later visits.</p></div></div>
    <div class="panel" style="margin-top:16px"><div class="tablewrap"><table class="t"><thead><tr><th>Skill</th><th>Attempts</th><th>First try</th><th>Recent</th><th>Variants ✓</th><th>Evidence</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="small muted" style="margin-top:8px">“Recent” = the last ${RECENT} answers in that skill, hints counting as misses. Mastered = at least 5 recent answers at ${t.settings.threshold}% or better, at least one generated variant solved (where variants exist) and nothing due for review. A training policy, not a protocol requirement.</p></div>`;
}

// ── Instructor ─────────────────────────────────────────────────────────────
function settingsTab(ctx, t) {
  const s = t.settings;
  document.getElementById('trBody').innerHTML = `<div class="grid2"><div class="panel"><h3>Instructor controls</h3>
    <div class="form"><label class="field">Pass / mastery threshold (%)<input type="number" min="50" max="100" data-tr-set="threshold" value="${s.threshold}"></label>
    <label class="field">Assessment size<input type="number" min="5" max="60" data-tr-set="size" value="${s.size}"></label>
    <label class="field">Generated variants in assessments (%)<input type="number" min="0" max="100" data-tr-set="varRatio" value="${s.varRatio}"></label>
    <label class="chip"><input type="checkbox" data-tr-set="evidenceInAssessment" ${s.evidenceInAssessment ? 'checked' : ''}> Require evidence selection in assessments</label></div>
    <p class="small muted">Practice shows hints and explanations immediately; Assessment hides both until the set is submitted. Settings are stored on this browser.</p></div>
    <div class="panel"><h3>Records</h3><p class="small">Progress is stored per question id and version (${questions.length} questions), so editing the bank never attaches old answers to different questions.</p>
    <div class="row"><button class="btn" data-tr="export">Export progress (JSON)</button><button class="btn danger" data-tr="reset">Reset training progress</button></div></div></div>`;
}

// ── events (delegated on the page body; the app re-renders on navigation) ──
function bind(ctx, t) {
  const root = ctx.main;
  if (root._trBound) { root._trCtx = { ctx, t }; return; }
  root._trBound = true; root._trCtx = { ctx, t };
  const rerender = () => renderTrainer(root._trCtx.ctx);
  const save = () => root._trCtx.ctx.saveProgress();
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-tr]'); if (!el || !root.contains(el)) return;
    const { t } = root._trCtx; const a = el.dataset.tr;
    if (a === 'tab') { U.tab = el.dataset.k; return rerender(); }
    if (U.tab === 'practice') {
      const q = U.cur?.q;
      if (a === 'level') { U.level = +el.dataset.l; U.cur = null; return rerender(); }
      if (a === 'choose' && !U.answered) { U.picked = +el.dataset.i; return checkPractice(t, q, save, rerender); }
      if (a === 'check' && !U.answered) { U.input = document.getElementById('trIn')?.value ?? ''; return checkPractice(t, q, save, rerender); }
      if (a === 'hint') { U.hinted = true; return rerender(); }
      if (a === 'pick') { togglePick(U.picks, +el.dataset.f, +el.dataset.o); return rerender(); }
      if (a === 'evcheck') { U.evDone = gradeEvidence(q, U.picks); recordEvidence(t, q, U.evDone.ok); if (q.kind === 'evidence-only') { U.answered = { ok: U.evDone.ok }; recordAttempt(t, q, U.evDone.ok, { sessionN: U.sessionN }); U.sessionN++; } save(); return rerender(); }
      if (a === 'next') { if (q && !q.generated) U.seen.add(q.id); U.cur = null; return rerender(); }
      if (a === 'variant') { const v = variantFor(q.gen && GENERATORS[q.gen] ? q.gen : q.skills.find((s) => BY_SKILL[s]) || q.skills[0], (Math.random() * 2 ** 31) >>> 0); if (v) { U.cur = { q: v }; U.answered = null; U.input = ''; U.picked = null; U.hinted = false; U.picks = []; U.evDone = null; } else root._trCtx.ctx.toast('No generated variants for this skill yet — try another question in it.'); return rerender(); }
    }
    if (a === 'drill') { U.tab = 'practice'; U.skill = el.dataset.s; U.level = 0; U.cur = null; return rerender(); }
    if (a === 'astart' || a === 'anew') {
      const lv = a === 'anew' ? (U.asmt?.levels || [1, 2, 3, 4, 5]) : [...root.querySelectorAll('[data-tr-lv]')].filter((x) => x.checked).map((x) => +x.dataset.trLv);
      if (!lv.length) return root._trCtx.ctx.toast('Choose at least one section.');
      U.asmt = { items: buildAssessment(t, { levels: lv, seed: (Math.random() * 2 ** 31) >>> 0 }), i: 0, ans: [], ev: [], levels: lv }; return rerender();
    }
    if (U.asmt && !U.asmt.result) {
      const A = U.asmt, q = A.items[A.i];
      const stash = () => { const inp = document.getElementById('trIn'); if (inp) A.ans[A.i] = inp.value; };
      if (a === 'choose') { A.ans[A.i] = +el.dataset.i; return rerender(); }
      if (a === 'pick') { stash(); A.ev[A.i] ||= []; togglePick(A.ev[A.i], +el.dataset.f, +el.dataset.o); return rerender(); }
      if (a === 'anext') { stash(); A.i++; return rerender(); }
      if (a === 'aprev') { stash(); A.i--; return rerender(); }
      if (a === 'aquit') { U.asmt = null; return rerender(); }
      if (a === 'asubmit') { stash(); A.result = scoreAssessment(t, A.items, A.ans, A.ev, { lv: A.levels }); save(); return rerender(); }
      void q;
    }
    if (a === 'psubmit') {
      const P = U.prac; root.querySelectorAll('[data-tr-pv]').forEach((x) => { P.ans[+x.dataset.trPv] = x.value; });
      P.res = practical.tasks.map((q, i) => grade(q, P.ans[i]).ok);
      P.score = P.res.filter(Boolean).length; P.done = true;
      practical.tasks.forEach((q, i) => recordAttempt(t, q, P.res[i]));
      const passed = P.score >= Math.ceil(practical.tasks.length * t.settings.threshold / 100);
      P.passed = passed;
      const prev = t.practical || {};
      // a pass is kept once earned on a blind attempt (answers are never shown before a pass)
      t.practical = { at: Date.now(), correct: P.score, total: practical.tasks.length, passed: passed || !!prev.passed, attempts: (prev.attempts || 0) + 1, best: Math.max(prev.best || 0, P.score) };
      save(); return rerender();
    }
    if (a === 'preset') { U.prac = null; return rerender(); }
    if (a === 'export') return root._trCtx.ctx.download('osdp-academy-training-progress.json', root._trCtx.ctx.progress.train);
    if (a === 'reset') { if (confirm('Reset all training progress on this browser?')) { delete root._trCtx.ctx.progress.train; root._trCtx.ctx.progress.answers = {}; save(); U.cur = null; U.asmt = null; U.prac = null; rerender(); } }
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'trIn' && e.target.tagName === 'INPUT') { e.preventDefault(); root.querySelector('[data-tr="check"], [data-tr="anext"], [data-tr="asubmit"]')?.click(); } });
  root.addEventListener('change', (e) => {
    const el = e.target; const { t } = root._trCtx;
    if (el.dataset.trCh === 'skill') { U.skill = el.value; U.cur = null; return rerender(); }
    if (el.dataset.trPt != null) { U.prac.ans[+el.dataset.trPt] = +el.value; return; }
    if (el.dataset.trSet) { const k = el.dataset.trSet; t.settings[k] = el.type === 'checkbox' ? el.checked : Math.max(+el.min || 0, Math.min(+el.max || 100, +el.value || 0)); save(); }
  });
}
function togglePick(arr, f, o) { const i = arr.findIndex(([a, b]) => a === f && b === o); if (i >= 0) arr.splice(i, 1); else arr.push([f, o]); }
function checkPractice(t, q, save, rerender) {
  const ans = q.kind === 'choice' ? U.picked : U.input;
  if (q.kind !== 'choice' && !String(ans).trim()) return;
  U.answered = grade(q, ans);
  recordAttempt(t, q, U.answered.ok, { hinted: U.hinted, sessionN: U.sessionN, first: true });
  U.sessionN++;
  save(); rerender();
}
export const _test = { U, hx2, STAGES, isDue, SESSION };
