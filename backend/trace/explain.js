// AETHER_TRACE (TRACE-9) — plain language for traces and door checks.
// explainTrace(t) → { say, problems: [{ note, plain, likely, check[], info? }] }: one sentence for what happened, and for each
// note from correlate a plain version, the likely cause and what to check. Kept apart from correlate so wording can change freely.
'use strict';

const sec = ms => ms == null ? null : ms > -500 && ms < 100 ? 'under 0.1 s' : ms < 0 ? `${(ms / 1000).toFixed(1)} s early` : ms < 950 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(ms < 9500 ? 1 : 0)} s`;
const credText = c => c ? `${c.fc != null && c.fc !== '' ? c.fc + '-' : ''}${c.cn ?? '?'}` : '';
const doorOf = t => (t.decision && t.decision.door && (t.decision.door.name || t.decision.door.id)) || null;
const roleSay = (role, v, type) => role === 'dps' ? (v ? 'Door opened' : 'Door closed') : role === 'rex' ? (v ? 'REX pressed' : 'REX released') : role === 'lock' ? (v ? 'Strike unlocked' : 'Strike locked') : `${role || 'Input'} ${v ? 'on' : 'off'}`;
const EVENT_SAY = {
  accessgranted: 'access granted', accessdenied: 'access denied', open: 'door open', dooropen: 'door open', closed: 'door closed', doorclosed: 'door closed',
  doorforcedopen: 'FORCED OPEN', rexactivated: 'REX', rexdeactivated: 'REX released', unlocked: 'unlocked', locked: 'locked',
};
const evSay = type => { if (!type) return null; const k = String(type).toLowerCase(); return EVENT_SAY[k] || EVENT_SAY[k.replace(/[^a-z]/g, '')] || (k.startsWith('accessdenied') ? 'access denied' : k.startsWith('accessgranted') ? 'access granted' : k.replace(/[_-]+/g, ' ')); };

function cloudTail(t) {
  const L = t.latency || {};
  if (L.push != null) return `OnCAFE had it ${sec(L.push)} after Aether acted`;
  if (L.api != null) return `it showed up in the OnCAFE event log after ${sec(L.api)}`;
  return 'OnCAFE never reported it';
}

function sentence(t) {
  const L = t.latency || {}, door = doorOf(t), at = door ? ` at ${door}` : '';
  if (t.kind === 'card') {
    const c = credText(t.action && t.action.cred) || 'card';
    if (!t.decision) return `Card ${c} was presented${at}, but the controller never decided on it.`;
    const r = t.result === 'grant' ? 'granted' : t.result === 'deny' ? 'denied' : evSay(t.result);
    const parts = [`Card ${c} was ${r}${at}${L.decision != null ? ` in ${sec(L.decision)}` : ''}`];
    if ((t.hops || []).some(h => h.id === 'lock')) parts.push('the lock opened');
    else if (t.result === 'grant') parts.push('Aether did not see the lock open');
    if (t.reader) parts.push(`the reader showed ${t.reader.colour}${t.reader.beep ? ' and beeped' : ''}`);
    parts.push(cloudTail(t));
    return parts.join('; ') + '.';
  }
  if (t.kind === 'input') {
    const what = roleSay(t.role, t.action && t.action.v);
    if (!t.decision) return `${what} (Aether moved it), but the controller never reported it.`;
    return `${what} (Aether moved it); the controller reported ${evSay(t.result)}${at}${L.decision != null ? ` after ${sec(L.decision)}` : ''}; ${cloudTail(t)}.`;
  }
  if (t.kind === 'command') {
    const what = (t.action && t.action.label) || 'Command';
    const p = [`${what}: OnCAFE ${L.ack != null ? `accepted it in ${sec(L.ack)}` : 'was asked'}`];
    if (t.decision) p.push(`the controller reported ${evSay(t.result)}${L.decision != null ? ` after ${sec(L.decision)}` : ''}`);
    else p.push('the controller never reported it');
    if (L.output != null) p.push(`the door hardware moved after ${sec(L.output)}`);
    return p.join('; ') + '.';
  }
  if (t.kind === 'output') {
    const what = roleSay(t.role, t.action && t.action.v);
    const cause = t.cause && (t.cause.label || t.cause.kind);
    const on = !!(t.action && t.action.v);
    return `${what}${at}${cause ? `, because of ${cause}` : on ? ', and nothing Aether saw asked for it' : ''}${t.held != null ? ` (held ${sec(t.held)})` : ''}.`;   // relocking needs no cause
  }
  return (t.action && t.action.label) || 'Something happened.';
}

// note pattern → plain words, likely cause, what to check
const RULES = [
  [/^No controller decision/, 'The controller never answered this card.',
    'The card never reached the controller, or the controller did not send its decision to OnCAFE.',
    ['Setup › Controller links: is the controller (or emulated board) talking to this Pi?', 'Suggested wiring: is this reader on the right controller reader port?', 'Is the card format the one the controller expects?', 'Setup › OnCAFE: is the cloud feed connected and this door picked?']],
  [/^Credential changed on the way/, 'The controller read a different card number than Aether sent.',
    'The card format or the Wiegand wiring does not match (for example D0/D1 swapped, or a 34-bit card read as 26-bit).',
    ['Card format in Setup › Sync cards / the test step vs the controller\'s card format', 'Wiegand D0 and D1 on the right terminals', 'Facility code range of the format']],
  [/^Expected (grant|deny), got/, 'The answer was not the one the test expected.',
    'The card\'s access in OnCAFE is not what the test assumes.',
    ['Is the card enrolled, and does its access level include this door?', 'Is the access level\'s schedule active right now?', 'Has the cardholder hit the 10-access-level limit (levels from groups count)?', 'Anti-passback or lockdown still on?']],
  [/^Decision took|reported \d+ ms after the change/, 'The controller was slow to decide.',
    'The controller was busy (syncing, many events) or its clock is drifting.',
    ['Was the controller syncing from OnCAFE at the time (Log Analytics › Cloud)?', 'Setup › Controller clocks: is the controller\'s clock right?', 'Run the same check again to see if it repeats']],
  [/before the card was sent|before the change|clock offset unknown|offset unknown/i, 'Aether could not line up the controller\'s clock with its own.',
    'The sync cards did not get a decision, so times from the controller are not corrected.',
    ['Setup › Sync cards: are both sync cards enrolled with access to the test door?', 'Setup › Controller clocks: is the controller on NTP?']],
  [/^Not seen from the cloud/, 'OnCAFE never reported this.',
    'The controller did not publish it, or Aether\'s cloud feed missed it.',
    ['Setup › OnCAFE: is the cloud feed connected, and is this door picked?', 'Is the controller online in OnCAFE?', 'Log Analytics on the controller\'s log: MQTT disconnects?']],
  [/^Cloud push after/, 'OnCAFE delivered this late.',
    'The controller\'s internet link or its cloud connection was slow or reconnecting.',
    ['Controller\'s network (ping/latency to the internet)', 'Log Analytics on the controller\'s log: MQTT reconnects or queue backlog?', 'Does it repeat on other doors of the same controller?']],
  [/^Reader showed/, 'The reader light did not match the decision.',
    'The reader\'s LED settings on the controller differ from what is expected.',
    ['Reader LED mode / OSDP LED settings on the controller', 'Is the reader on the door it is assigned to?']],
  [/REX release/, 'The controller did not report the REX release.',
    'Many doors have "show REX events" off for releases: this is usually fine.', [], true],
  [/^Strike held/, 'The strike stayed unlocked for a different time than the door is set to.',
    'The door\'s unlock time in OnCAFE and on the controller differ, or extended access applied.',
    ['Door › unlock (grant) time in OnCAFE', 'Was it an extended-access card?']],
  [/nothing Aether saw asked for it/, 'The strike moved and Aether did not cause it.',
    'A schedule, an automation, or someone in OnCAFE unlocked it.',
    ['Door schedules (unlock schedules) in OnCAFE', 'Did anyone use the OnCAFE app at that time?']],
  [/^Controller never reported|^Controller did not report/, 'The controller did not see this change.',
    'The input is not wired to the terminal the controller watches, or its polarity / supervision is set differently.',
    ['Suggested wiring: is this relay on the right controller input (DPS / REX)?', 'NO vs NC (Setup › Wiring "on means") and EOL supervision on the controller input', 'Setup › Controller links: is the emulated board being polled?']],
  [/FORCED OPEN/, 'The controller called it a forced door although it was unlocked.',
    'The controller did not count the unlock (strike or grant) before the door opened — usually timing or the wrong strike output.',
    ['Is the lock wired to the strike output of this door?', 'Door open delay vs unlock time on the controller', 'Run it again with a slower step gap']],
  [/^OnCAFE refused the command/, 'OnCAFE refused the command.', 'The command is not allowed for this door or account.',
    ['Account rights in OnCAFE', 'Is the door in an area that allows it (lockdown needs an area)?']],
  [/answered the command after/, 'The command took too long to reach the door.', 'Cloud → controller delivery was slow.',
    ['Controller\'s internet link', 'Log Analytics: SDK/cloud delays on the controller']],
  [/did not see the strike output change/, 'Aether did not see the lock move.', 'Aether\'s lock monitor is not wired to this door\'s strike output, or not mapped.',
    ['Suggested wiring: lock monitor (OPTO) on the controller\'s door output', 'Setup › Wiring: a lock channel for this door']],
  // a step Aether could not carry out (door check / tests)
  [/^Could not put .* back/, 'Aether could not put this input back: check the door now.', 'The relay or emulated input did not answer when Aether released it.',
    ['Look at the door: DPS / REX may still be active', 'Is the Controller Emulator (or the relay board) running?']],
  [/is not running on this Pi|has no reader/, 'Aether could not present the card.', 'This door\'s reader is not running on this Pi.',
    ['Doors page › Settings › Reader for this door', 'Is that Wiegand / OSDP reader (or emulated board) started?']],
  [/board emulator is not loaded|emulated board refused/i, 'Aether could not move this door\'s input.', 'The door uses an emulated Azure board, and the Controller Emulator is not running.',
    ['Start the Controller Emulator', 'Setup › Controller links: is the Azure controller polling the board?']],
  [/is turned off|not on the Doors page/, 'This door cannot be used right now.', 'The door is turned off or was removed on the Doors page.', ['Doors page: turn the door on']],
  // door-check / test grader messages
  [/^The controller never reported a decision/, 'The controller never answered this card.',
    'The card never reached the controller, or its decision did not reach OnCAFE.',
    ['Setup › Controller links: is the controller (or emulated board) talking to this Pi?', 'Suggested wiring: is this reader on the right controller reader port?', 'Is the card format the one the controller expects?']],
  [/^Expected a grant, got/, 'A card that should open the door was refused.',
    'The card has no access to this door right now in OnCAFE.',
    ['Setup › Ready to trace › Test cards: is the "valid" card enrolled with access to this door?', 'Is its access level\'s schedule active now?', 'Lockdown or anti-passback still on?']],
  [/^Expected a denial, got/, 'A card that should be refused opened the door.',
    'The "card without access" is actually enrolled with access, or the door is unlocked by a schedule.',
    ['Setup › Ready to trace › Test cards: pick a card number nobody has', 'Door unlock schedules in OnCAFE']],
  [/^Aether did not record the card/, 'Aether could not present the card.', 'The door has no working reader on this Pi.',
    ['Doors page › Settings › Reader for this door', 'Is the Wiegand / OSDP reader (or emulated board) running?']],
  [/^Aether did not record the input change/, 'Aether could not move this input.', 'The door\'s DPS / REX is not set up on the Doors page.',
    ['Doors page › Settings: DPS and REX channels for this door']],
  [/^No .* from the controller within/, 'The controller did not report what this step should cause.',
    'The input is not wired to the terminal the controller watches, or the door is set up differently on the controller.',
    ['Suggested wiring: is this relay on the right controller input?', 'NO vs NC and EOL supervision on the controller input', 'Door settings on the controller (forced / held-open alarms on?)']],
  [/^The controller reported /, 'The controller reported something this step should not cause.', 'The door\'s state or settings differ from what the step assumes.',
    ['Was the door left open or unlocked by the step before?']],
  [/^No strike channel for this door/, 'The lock was not checked.', 'Aether does not watch this door\'s lock output.',
    ['Doors page lock channel, or Suggested wiring: lock monitor'], true],
  [/^The strike turned on/, 'The lock opened when it should have stayed locked.', 'The door was unlocked by something else, or the card has access.',
    ['Door unlock schedules / overrides in OnCAFE', 'The "card without access" really has none?']],
  [/did not turn on within/, 'The lock did not open.', 'The controller granted but the strike output did not move, or Aether is watching the wrong output.',
    ['Suggested wiring: lock monitor (OPTO) on this door\'s strike output', 'Strike / relay on the controller']],
  [/^The strike relocked after|^Held .* wanted/, 'The lock stayed open for a different time than expected.', 'The door\'s unlock time differs from the test\'s.',
    ['Door › unlock (grant) time in OnCAFE']],
  [/^Output changed .* after the controller reported it/, 'The door hardware moved late.', 'The output relay or the strike is slow, or the clock offset is off.',
    ['Strike / relay hardware', 'Setup › Controller clocks']],
];

function explainNote(note) {
  for (const [re, plain, likely, check, info] of RULES) if (re.test(note)) return { note, plain, likely, check, ...(info ? { info: true } : {}) };
  return { note, plain: note, likely: null, check: [] };
}

function explainTrace(t) {
  return { say: sentence(t), problems: (t.notes || []).map(explainNote) };
}

/** Door check verdict from a graded test report (report.steps from tests.grade) and the run's traces:
 *  { ok, headline, lines: [{ label, ok, warn, say, problems }], notChecked: [] } */
function doorVerdict(doorName, report, traces = [], notChecked = []) {
  const byId = new Map((traces || []).map(t => [t.id, t]));
  const rows = ((report && report.steps) || []).filter(r => r && r.kind !== 'wait' && r.status !== 'skipped');
  const lines = rows.map(r => {
    const ok = r.status === 'pass' || r.status === 'warn';
    const tr = r.traceId ? byId.get(r.traceId) : null;
    const problems = (r.why || []).concat(tr && !ok ? tr.notes || [] : []).map(explainNote).filter(p => !p.info)
      .filter((p, i, a) => a.findIndex(q => q.plain === p.plain) === i);
    return { label: String(r.text || r.kind).replace(/ · .*$/, ''), ok, warn: r.status === 'warn', say: tr ? sentence(tr) : null, problems };
  });
  const bad = lines.filter(l => !l.ok), slow = lines.filter(l => l.ok && l.warn && l.problems.length);
  const headline = !lines.length ? `${doorName}: nothing could be checked.`
    : bad.length ? `${doorName}: ${bad.length} problem${bad.length === 1 ? '' : 's'} — ${bad.map(b => (/^[A-Z][a-z]/.test(b.label) ? b.label[0].toLowerCase() + b.label.slice(1) : b.label)).join(', ')}.`
    : slow.length ? `${doorName}: works, with ${slow.length} thing${slow.length === 1 ? '' : 's'} to look at.`
    : `${doorName}: works.`;
  return { ok: !bad.length && lines.length > 0, headline, lines, notChecked };
}

module.exports = { explainTrace, explainNote, sentence, doorVerdict, sec };
