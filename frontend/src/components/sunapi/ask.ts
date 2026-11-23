// AETHER_SUNAPI_LIMITS — "Ask": plain-language questions answered from the report itself (offline, no AI).
// Every number in an answer comes from a report row and names that row as its source.
import { meta, rowsOf, type Report } from './limitsDiff';
import { ONCAFE, oncafeRows, type OncafeRow } from './oncafe';

export interface Line { text: string; strong?: string; source?: string; tone?: 'good' | 'bad' | 'warn' }
export interface Answer { title: string; lines: Line[]; suggest: string[]; understood: boolean }

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const fmt = (v: string) => { const n = Number(v); return Number.isFinite(n) && /^\d+$/.test(v) ? n.toLocaleString() : v; };

/** words people use -> OnCAFE term (base term; "(measured)" and per-identity variants are found from it) */
const SUBJECTS: { term: string; words: string[]; perId?: string }[] = [
  { term: 'Access Levels', words: ['access level', 'access levels', 'levels', 'level', 'access profile', 'access profiles', 'accessprofile', 'policy', 'policies'], perId: 'Access Levels per identity' },
  { term: 'Doors per Access Level', words: ['doors per access level', 'doors per level', 'doors in a level', 'doors in an access level', 'door per level'] },
  { term: 'Schedules per door in an Access Level', words: ['schedules per door', 'schedules in a level', 'schedules per access level'] },
  { term: 'Cardholder Groups', words: ['group', 'groups', 'cardholder group', 'cardholder groups', 'access group', 'access groups', 'accessgroup'], perId: 'Groups per identity' },
  { term: 'Identities / credentials', words: ['identity', 'identities', 'cardholder', 'cardholders', 'user', 'users', 'people', 'person', 'persons', 'employees', 'credential', 'credentials'] },
  { term: 'Cards and PINs', words: ['card', 'cards', 'pin', 'pins', 'badge', 'badges', 'card number', 'card numbers', 'credential method', 'credential methods', 'fobs', 'fob'], perId: 'Cards / PINs per identity' },
  { term: 'Schedules', words: ['schedule', 'schedules', 'time zone', 'time zones', 'timezone', 'timezones'] },
  { term: 'Time slots per day', words: ['time slot', 'time slots', 'slots', 'periods', 'time periods', 'intervals'] },
  { term: 'Holiday groups', words: ['holiday', 'holidays', 'holiday group', 'holiday groups', 'special day', 'special days', 'specialday'] },
  { term: 'Days per holiday group', words: ['days per holiday', 'dates per holiday', 'holiday dates', 'days in a holiday'] },
  { term: 'Doors', words: ['door', 'doors'] },
  { term: 'Readers', words: ['reader', 'readers', 'card reader', 'card readers'] },
  { term: 'Door entry / exit points', words: ['access point', 'access points', 'entry', 'exit', 'entries'] },
  { term: 'Areas', words: ['area', 'areas', 'zone', 'zones'] },
  { term: 'Reader security modes', words: ['security level', 'security levels', 'card and pin', 'card plus pin', 'security mode', 'security modes'] },
  { term: 'Authentication profiles', words: ['authentication profile', 'authentication profiles', 'auth profile', 'auth profiles'] },
  { term: 'Event listeners', words: ['stream', 'streams', 'listener', 'listeners', 'monitor', 'monitordiff', 'event stream', 'event streams', 'subscribers', 'vms'] },
  { term: 'Door event delay (controller part)', words: ['event delay', 'event latency', 'delay', 'latency to cloud', 'how fast do events', 'event time'] },
];
const PER_ID = /\b(per|each|one|a single|every|for an?|can an?)\s+(identity|person|user|cardholder|credential|employee|card holder|badge)\b|\b(identity|person|user|cardholder|employee) (can )?(hold|have|get|be in)\b/;
const NAME_LEN = /\b(name|names)\b.*\b(long|length|characters?|chars?)\b|\b(long|length|characters?)\b.*\bname/;

export const EXAMPLES = [
  'How many Access Levels does this allow?',
  'How many access levels can one identity have?',
  'How many schedules and holidays?',
  'What failed?',
  'How long is the door released?',
  'Can a Yealink phone call it directly?',
];
export const COMPARE_EXAMPLES = ['What changed for access levels?', 'What got worse?', 'What changed in the API?', 'Is anything new in B?'];

function findSubjects(q: string) {
  const hits: { s: (typeof SUBJECTS)[number]; len: number; at: number }[] = [];
  for (const s of SUBJECTS) for (const w of s.words) { const i = q.indexOf(` ${w} `); if (i >= 0) hits.push({ s, len: w.length, at: i }); }
  // longest phrase wins where phrases overlap ("doors per access level" beats "doors" and "access level")
  hits.sort((a, b) => b.len - a.len);
  const taken: [number, number][] = [], out: (typeof SUBJECTS)[number][] = [];
  for (const h of hits) {
    const span: [number, number] = [h.at, h.at + h.len + 1];
    if (taken.some(([x, y]) => span[0] < y && span[1] > x)) continue;
    taken.push(span); if (!out.includes(h.s)) out.push(h.s);
  }
  return out;
}

const confWord = (r: OncafeRow) => (r.conf === 'confirmed' ? '' : r.conf === 'field' ? '' : ' (OnCAFE name: likely match)');
function limitLines(rows: OncafeRow[], term: string, perIdAsked: boolean, perIdTerm?: string): Line[] {
  const L: Line[] = [];
  const base = rows.find(r => r.term === term), meas = rows.find(r => r.term === `${term} (measured)`), pid = perIdTerm ? rows.find(r => r.term === perIdTerm) : undefined;
  const primary = perIdAsked && pid ? pid : base;
  if (primary) {
    const unit = /delay/i.test(primary.term) ? ' s' : '';
    const scope = primary === pid || / per |delay|length/.test(primary.term) ? '' : 'per controller ';
    L.push({ strong: `${fmt(primary.value)}${unit} ${primary.term}`, text: ` ${scope}(${primary.source === 'declared' ? 'declared by the firmware' : primary.source}).${confWord(primary)}`, source: primary.sunapi });
  }
  if (primary === base && meas) {
    const same = meas.value === base!.value;
    L.push({ text: `Measured by the capacity test: ${fmt(meas.value)} stored before the controller refused${same ? ', matching the declared limit.' : `. Declared ${fmt(base!.value)} — they disagree.`}`, source: meas.sunapi, tone: same ? 'good' : 'bad' });
  } else if (primary === base && !meas && /Access Levels|Schedules|Holiday|Cardholder Groups/.test(term)) {
    L.push({ text: 'Not measured in this run. Run the Capacity level (or the Push sequence) to confirm it by pushing objects.', tone: 'warn' });
  }
  if (!perIdAsked && pid) L.push({ strong: `${fmt(pid.value)} per identity`, text: ` (${pid.term}).${pid.note ? ' ' + pid.note + '.' : ''}`, source: pid.sunapi });
  if (perIdAsked && primary === pid && base) L.push({ text: `The controller holds ${fmt(base.value)} ${base.term} in total.`, source: base.sunapi });
  if (primary?.note && primary !== pid && !/^SUNAPI/.test(primary.note)) L.push({ text: primary.note + '.' });
  return L;
}

function resultsLines(rep: Report, want: string[], limit = 12): Line[] {
  const rows = rowsOf(rep, 'Results').filter(r => want.includes(String(r.Result)));
  const out: Line[] = rows.slice(0, limit).map(r => ({ strong: `${r.Result} `, text: `${r.Test}: ${String(r.Measured).slice(0, 180)}`, source: `Results ${r.ID}`, tone: r.Result === 'LIMIT' ? 'warn' as const : 'bad' as const }));
  if (rows.length > limit) out.push({ text: `…and ${rows.length - limit} more on the Results sheet.` });
  return out;
}
function findResult(rep: Report, rx: RegExp) { return rowsOf(rep, 'Results').find(r => rx.test(`${r.ID} ${r.Test}`)); }

/** Answer a question about one report. */
export function ask(question: string, rep: Report): Answer {
  const q = norm(question);
  const rows = oncafeRows(rep), m = meta(rep);
  const pm = q.match(PER_ID);
  const perId = !!pm;
  // the "per person / one cardholder" phrase steers the answer; it is not itself the subject
  let subjects = findSubjects(pm ? q.replace(pm[0], ' ') : q);
  if (!subjects.length) subjects = findSubjects(q);
  const suggest = (xs: string[]) => xs.filter(x => norm(x) !== q).slice(0, 4);

  if (/\b(fail|failed|failing|fails|error|errors|broken|problem|problems|issue|issues|wrong|bug|bugs)\b/.test(q) && !subjects.length) {
    const L = resultsLines(rep, ['FAIL', 'ERROR']);
    const bad = rowsOf(rep, 'Push checks').filter(r => ['NOT APPLIED', 'PARTIAL'].includes(String(r.Verdict)));
    bad.slice(0, 6).forEach(r => L.push({ strong: `${r.Verdict} `, text: `${r.Test}: sent ${String(r.Pushed).slice(0, 60)}, read back ${String(r['After (reinspect)']).slice(0, 80)}`, source: `Push checks ${r.ID}`, tone: 'bad' }));
    return { title: L.length ? `${L.length} problem${L.length > 1 ? 's' : ''} in this run` : 'Nothing failed in this run', lines: L.length ? L : [{ text: 'No FAIL or ERROR results, and every push check read back what was sent.', tone: 'good' }], understood: true, suggest: suggest(['What limits did it hit?', 'How many Access Levels does this allow?']) };
  }
  if (/\b(limits? (hit|found|reached)|what limits|restrictions?|limitations?)\b/.test(q) && !subjects.length) {
    const L = resultsLines(rep, ['LIMIT'], 20);
    return { title: `${L.length} limits found`, lines: L, understood: true, suggest: suggest(['What failed?', 'How many schedules?']) };
  }
  if (/\b(firmware|version|model|build)\b/.test(q) && !subjects.length) {
    return { title: `${m.Model || 'Controller'} on ${m.Firmware || 'unknown firmware'}`, lines: [{ text: [m.Controller, m['Device type'] && `type ${m['Device type']}`, m.Started && `tested ${m.Started}`, m['Levels run'] && `levels: ${m['Levels run']}`].filter(Boolean).join(' · '), source: 'Summary' }], understood: true, suggest: suggest(EXAMPLES) };
  }
  if (NAME_LEN.test(q)) {
    const L: Line[] = rows.filter(r => /name length/.test(r.term)).map(r => ({ strong: `${r.value} characters`, text: ` for ${r.term.replace(' name length', '')} names (pushed, then read back).`, source: r.sunapi }));
    const trunc = rowsOf(rep, 'Results').filter(r => /SILENT TRUNCATION/.test(String(r.Measured)));
    trunc.forEach(r => L.push({ text: `${r.Test}: ${r.Measured}`, source: `Results ${r.ID}`, tone: 'bad' }));
    return { title: 'Longest names the controller keeps', lines: L.length ? L : [{ text: 'Not measured. Run the Capacity level.', tone: 'warn' }], understood: true, suggest: suggest(EXAMPLES) };
  }
  if (/\b(release|released|unlock|unlocked|open|opens)\b.*\b(time|long|seconds?|duration)\b|\bhow long\b.*\b(door|unlock|release)/.test(q)) {
    const lim = rowsOf(rep, 'Limits');
    const L: Line[] = lim.filter(r => /Timings\.ReleaseTime$/.test(String(r['Limit / property']))).map(r => ({ strong: `${r.Value} s `, text: `${String(r['Limit / property']).replace(' Timings.ReleaseTime', '')} release time (configured).`, source: String(r['Limit / property']) }));
    const obs = lim.find(r => /^(Observed release duration|Release duration by events)/.test(String(r['Limit / property'])));
    if (obs) L.push({ text: `Measured: ${obs.Value} s.`, source: String(obs['Limit / property']) });
    const ov = findResult(rep, /release-time override/);
    if (ov) L.push({ text: 'A release command cannot carry its own time (AccessTimingOverride=false); it always uses the door’s release time.', source: `Results ${ov.ID}`, tone: 'warn' });
    return { title: 'Door release time', lines: L.length ? L : [{ text: 'No door data in this run. Run Discovery (and Door for a measurement).', tone: 'warn' }], understood: true, suggest: suggest(['How fast do door events reach the cloud?', 'How many doors?']) };
  }
  if (/\b(yealink|phone|phones|basic auth|basic|simple client|plc)\b/.test(q)) {
    const r = findResult(rep, /^P05 /);
    return { title: r ? (/ACCEPTED/.test(String(r.Measured)) ? 'Yes: Basic login works' : 'No: it needs a relay') : 'Not tested in this run', lines: r ? [{ text: `${r.Measured}. ${r.Notes || ''}`, source: `Results ${r.ID}`, tone: /ACCEPTED/.test(String(r.Measured)) ? 'good' : 'warn' }] : [{ text: 'Run the Protocol level: it checks whether Basic login (what Yealink URL keys send) is accepted.', tone: 'warn' }], understood: true, suggest: suggest(EXAMPLES) };
  }
  if (/\b(lockout|lock out|locked out|wrong password|brute)\b/.test(q)) {
    const lim = rowsOf(rep, 'Limits').filter(r => /Login lockout/.test(String(r['Limit / property'])));
    return { title: 'Login lockout', lines: lim.length ? lim.map(r => ({ strong: `${r.Value} `, text: String(r['Limit / property']).replace('Login lockout ', ''), source: String(r['Limit / property']) })) : [{ text: 'Not tested in this run. Run the Login lockout level (use a spare user).', tone: 'warn' }], understood: true, suggest: suggest(EXAMPLES) };
  }
  if (/\b(latency|response time|how fast|slow|speed)\b/.test(q) && !subjects.some(s => s.term.startsWith('Door event'))) {
    const lim = rowsOf(rep, 'Limits').filter(r => /latency|rate \(req\/s\)|Concurrent clients/.test(String(r['Limit / property'])));
    return { title: 'Speed', lines: lim.length ? lim.map(r => ({ strong: `${r.Value} `, text: String(r['Limit / property']), source: String(r['Limit / property']) })) : [{ text: 'Run the Load level for response times.', tone: 'warn' }], understood: true, suggest: suggest(EXAMPLES) };
  }

  if (subjects.length) {
    const lines: Line[] = []; let title = '';
    for (const s of subjects.slice(0, 4)) {
      const L = limitLines(rows, s.term, perId, s.perId);
      if (!L.length) { lines.push({ strong: `${s.term}: `, text: 'not in this report. Run the Discovery level (capabilities) to get the declared limit.', tone: 'warn' }); continue; }
      if (subjects.length > 1) lines.push({ strong: `${s.term}` , text: '' });
      lines.push(...L);
      if (!title) title = L[0].strong ? `${L[0].strong}` : s.term;
    }
    if (subjects.length > 1) title = subjects.map(s => s.term).join(' · ');
    const related = subjects.flatMap(s => ONCAFE.filter(e => e.term !== s.term && !e.term.includes('measured') && !/length|delay/.test(e.term) && (e.term.includes(s.term.split(' ')[0]) || (s.perId && e.term === s.perId))).map(e => `How many ${e.term.toLowerCase()}?`));
    return { title, lines, understood: true, suggest: suggest([...new Set(related)].concat(EXAMPLES)) };
  }
  return { title: 'I can answer from this report about…', understood: false, suggest: EXAMPLES,
    lines: [{ text: 'Limits under their OnCAFE names (Access Levels, Schedules, Holiday groups, Cardholder Groups, Identities, Cards and PINs, Doors, Readers, Areas, event streams), per-identity limits, what failed or hit a limit, door release time, login lockout, speed, Basic login for phones, firmware and model. Try one of the examples.' }] };
}

/** Answer a question about two reports (Compare tab). */
export function askCompare(question: string, A: Report, B: Report): Answer {
  const q = norm(question);
  const ra = oncafeRows(A), rb = oncafeRows(B), mA = meta(A), mB = meta(B);
  const fa = mA.Firmware || 'A', fb = mB.Firmware || 'B';
  const subjects = findSubjects(q);
  if (subjects.length) {
    const lines: Line[] = [];
    for (const s of subjects.slice(0, 4)) {
      for (const t of [s.term, `${s.term} (measured)`, ...(s.perId ? [s.perId] : [])]) {
        const a = ra.find(r => r.term === t), b = rb.find(r => r.term === t);
        if (!a && !b) continue;
        const na = Number(a?.value), nb = Number(b?.value);
        const d = Number.isFinite(na) && Number.isFinite(nb) ? nb - na : null;
        const lowerBetter = /delay/i.test(t);
        lines.push({ strong: `${t}: `, text: `${a ? fmt(a.value) : '—'} → ${b ? fmt(b.value) : '—'}${d ? ` (${d > 0 ? '+' : ''}${fmt(String(d))})` : a?.value === b?.value ? ' (no change)' : ''}`,
          source: (a || b)!.sunapi, tone: d ? ((d > 0) !== lowerBetter ? 'good' : 'bad') : undefined });
      }
    }
    return { title: `${subjects.map(s => s.term).join(' · ')}: ${fa} → ${fb}`, lines: lines.length ? lines : [{ text: 'Neither report has this. Run the Discovery level on both firmwares.', tone: 'warn' }], understood: true, suggest: COMPARE_EXAMPLES };
  }
  const res = (rep: Report) => new Map(rowsOf(rep, 'Results').map(r => [`${r.Level}·${r.Test}`, r]));
  const RANK: Record<string, number> = { PASS: 0, INFO: 1, SKIP: 1, LIMIT: 2, FAIL: 3, ERROR: 3 };
  if (/\b(worse|regress|regression|regressions|broke|broken|fail|failed|problems?)\b/.test(q)) {
    const a = res(A), b = res(B), L: Line[] = [];
    b.forEach((rb2, k) => { const r1 = a.get(k); if (r1 && (RANK[String(rb2.Result)] ?? 1) > (RANK[String(r1.Result)] ?? 1)) L.push({ strong: `${r1.Result} → ${rb2.Result} `, text: `${rb2.Test}: ${String(rb2.Measured).slice(0, 160)}`, source: `Results ${rb2.ID}`, tone: 'bad' }); });
    return { title: L.length ? `${L.length} test${L.length > 1 ? 's' : ''} got worse in ${fb}` : `Nothing got worse in ${fb}`, lines: L.length ? L : [{ text: 'No test dropped a grade (PASS < INFO/SKIP < LIMIT < FAIL/ERROR).', tone: 'good' }], understood: true, suggest: COMPARE_EXAMPLES };
  }
  if (/\b(api|command|commands|menu|menus|parameter|parameters|spec|new|added|removed)\b/.test(q)) {
    const key = (r: Record<string, unknown>) => `${r.CGI}/${r.Submenu}/${r.Action}${r.Parameter ? ' · ' + r.Parameter : ''}`;
    const sa = new Map(rowsOf(A, 'API spec').map(r => [key(r), r])), sb = new Map(rowsOf(B, 'API spec').map(r => [key(r), r]));
    const add = [...sb.keys()].filter(k => !sa.has(k)), rem = [...sa.keys()].filter(k => !sb.has(k));
    const chg = [...sb.keys()].filter(k => sa.has(k) && String(sa.get(k)!['Allowed values / range']) !== String(sb.get(k)!['Allowed values / range']));
    const L: Line[] = [...add.slice(0, 8).map(k => ({ strong: 'Added ', text: k, source: 'API spec', tone: 'good' as const })), ...rem.slice(0, 8).map(k => ({ strong: 'Removed ', text: k, source: 'API spec', tone: 'bad' as const })),
      ...chg.slice(0, 8).map(k => ({ strong: 'Changed ', text: `${k}: ${sa.get(k)!['Allowed values / range']} → ${sb.get(k)!['Allowed values / range']}`, source: 'API spec' }))];
    return { title: `API spec: ${add.length} added, ${rem.length} removed, ${chg.length} changed`, lines: L.length ? L : [{ text: 'The command lists are the same.' }], understood: true, suggest: COMPARE_EXAMPLES };
  }
  if (/\b(changed|change|difference|differences|different|diff)\b/.test(q)) {
    const L: Line[] = [];
    for (const t of new Set([...ra.map(r => r.term), ...rb.map(r => r.term)])) {
      const a = ra.find(r => r.term === t), b = rb.find(r => r.term === t);
      if (a?.value !== b?.value) L.push({ strong: `${t}: `, text: `${a ? fmt(a.value) : '—'} → ${b ? fmt(b.value) : '—'}`, source: (a || b)!.sunapi });
    }
    return { title: L.length ? `${L.length} OnCAFE limits changed` : 'No OnCAFE limit changed', lines: L, understood: true, suggest: COMPARE_EXAMPLES };
  }
  return { title: 'Ask about the two firmwares', understood: false, suggest: COMPARE_EXAMPLES, lines: [{ text: `Name a limit (“access levels”, “schedules”, “holidays”…), or ask what got worse, what changed, or what changed in the API between ${fa} and ${fb}.` }] };
}
