// trace/commands.js — OnCAFE door / area / zone commands: recognise them (Traffic Inspector, HAR) and build them
// (Aether sending one itself). Request shapes confirmed from the OnCAFE web app (Jira HARs, 2026-11).   AETHER_TRACE
//
//   PUT  /acsio/orgs/{org}/area/{area}/lockdown                {lockdown: true|false}
//   POST /acsio/orgs/{org}/entity/temporaryOverride            {areaId, temporaryOverrideSchedule:[{doorId, behaviour:'unlock'|'lock',
//                                                               enable:true, standard:{vcalendar:[{vevent:[{dtstart, dtend}]}]}}]}  (site local time)
//   PUT  /acsio/orgs/{org}/entity/cancelTemporaryOverride      {areaId, doorScheduleIds:[{doorId, scheduleId}]}
//   PUT  /acsio/orgs/{org}/door/{door}/manageMaintenanceMode   {maintenanceState: true|false}
//   PUT  /acsio/orgs/{org}/(door|elevator)/{id}/shuntReader    {shuntReader: true|false}
//   PUT  /acsio/orgs/{org}/zone/{zone}/outputzone/state        {state: 'activate'|'deactivate'}
//   PUT  /acsio/orgs/{org}/zone/{zone}/inputzone/state         {state: 'arm'|'disarm'}
'use strict';

const { newId } = require('./normalize');

const ID = '([0-9a-f-]{36})';
const RULES = [
  { re: new RegExp(`/acsio/orgs/${ID}/area/${ID}/lockdown$`, 'i'), m: 'PUT', kind: 'lockdown', target: x => x[2], value: b => !!(b && b.lockdown) },
  { re: new RegExp(`/acsio/orgs/${ID}/entity/temporaryOverride$`, 'i'), m: 'POST', kind: 'override', target: (_x, b) => ((b && b.temporaryOverrideSchedule) || []).map(o => o.doorId).filter(Boolean), value: b => (((b && b.temporaryOverrideSchedule) || [])[0] || {}).behaviour || 'unlock', area: b => b && b.areaId },
  { re: new RegExp(`/acsio/orgs/${ID}/entity/cancelTemporaryOverride$`, 'i'), m: 'PUT', kind: 'override-cancel', target: (_x, b) => ((b && b.doorScheduleIds) || []).map(o => o.doorId).filter(Boolean), value: () => null, area: b => b && b.areaId },
  { re: new RegExp(`/acsio/orgs/${ID}/door/${ID}/manageMaintenanceMode$`, 'i'), m: 'PUT', kind: 'maintenance', target: x => x[2], value: b => !!(b && b.maintenanceState) },
  { re: new RegExp(`/acsio/orgs/${ID}/(?:door|elevator)/${ID}/shuntReader$`, 'i'), m: 'PUT', kind: 'shunt', target: x => x[2], value: b => !!(b && b.shuntReader) },
  { re: new RegExp(`/acsio/orgs/${ID}/zone/${ID}/outputzone/state$`, 'i'), m: 'PUT', kind: 'outputzone', target: x => x[2], value: b => (b && b.state) || '' },
  { re: new RegExp(`/acsio/orgs/${ID}/zone/${ID}/inputzone/state$`, 'i'), m: 'PUT', kind: 'inputzone', target: x => x[2], value: b => (b && b.state) || '' },
];
const LABEL = {
  lockdown: v => (v ? 'Lockdown on' : 'Lockdown off'), override: v => `Temporary ${v || 'unlock'}`, 'override-cancel': () => 'Cancel temporary override',
  maintenance: v => (v ? 'Maintenance mode on' : 'Maintenance mode off'), shunt: v => (v ? 'Shunt reader' : 'Unshunt reader'),
  outputzone: v => `Output zone ${v}`, inputzone: v => `Input zone ${v}`,
};

/** A request to OnCAFE → { kind, target, value, area, org } or null. */
function parseCommand(method, url, body) {
  let path = '';
  try { path = new URL(url, 'https://x').pathname; } catch { path = String(url || '').split('?')[0]; }
  if (!/hanwhavision\.cloud|^\//.test(String(url))) return null;
  let b = body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  for (const r of RULES) {
    if (String(method || '').toUpperCase() !== r.m) continue;
    const x = r.re.exec(path);
    if (!x) continue;
    return { kind: r.kind, target: r.target(x, b), value: r.value(b), area: r.area ? r.area(b) : undefined, org: x[1] };
  }
  return null;
}

const labelOf = cmd => `${(LABEL[cmd.kind] || (() => cmd.kind))(cmd.value)}${cmd.targetName ? ' · ' + cmd.targetName : ''}`;

function commandEvent(cmd, o) {
  return {
    id: newId(), src: o.src, lane: 'cloud', at: o.at, t: o.at, clock: o.clock || 'pi', type: 'command', label: labelOf(cmd),
    door: null, controllerId: null, cred: null, clientType: o.by || null, eventId: null, topic: null, access: false,
    cmd: { kind: cmd.kind, target: cmd.target, value: cmd.value, area: cmd.area, targetName: cmd.targetName },
    info: { by: o.by, ackMs: o.ackMs, status: o.status, error: o.error, via: o.via },
  };
}

/** Site-local 'YYYYMMDDTHHmmss' in an IANA zone (OnCAFE temporary overrides use the site's local time). */
function localStamp(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

/** Request Aether sends for a command: { method, path, body } (path below {io}/{org}). */
function buildRequest(cmd, ctx = {}) {
  const now = Date.now();
  switch (cmd.kind) {
    case 'lockdown': return { method: 'PUT', path: `/area/${cmd.target}/lockdown`, body: { lockdown: !!cmd.value } };
    case 'maintenance': return { method: 'PUT', path: `/door/${cmd.target}/manageMaintenanceMode`, body: { maintenanceState: !!cmd.value } };
    case 'shunt': return { method: 'PUT', path: `/door/${cmd.target}/shuntReader`, body: { shuntReader: !!cmd.value } };
    case 'outputzone': return { method: 'PUT', path: `/zone/${cmd.target}/outputzone/state`, body: { state: cmd.value === 'activate' ? 'activate' : 'deactivate' } };
    case 'inputzone': return { method: 'PUT', path: `/zone/${cmd.target}/inputzone/state`, body: { state: cmd.value === 'arm' ? 'arm' : 'disarm' } };
    case 'override': {
      if (!cmd.area) throw Object.assign(new Error('That door has no area in OnCAFE; a temporary override needs one'), { status: 400 });
      const secs = Math.max(5, Math.min(3600, Number(cmd.seconds) || 10));
      return {
        method: 'POST', path: '/entity/temporaryOverride',
        body: { areaId: cmd.area, temporaryOverrideSchedule: [{ doorId: cmd.target, behaviour: cmd.value === 'lock' ? 'lock' : 'unlock', enable: true,
          standard: { vcalendar: [{ vevent: [{ dtstart: localStamp(now, ctx.tz), dtend: localStamp(now + secs * 1000, ctx.tz) }] }] } }] },
      };
    }
    default: throw Object.assign(new Error('Unknown command'), { status: 400 });
  }
}
/** The command that undoes one (for "turn it back after N s"). */
function reverseOf(cmd) {
  switch (cmd.kind) {
    case 'lockdown': case 'maintenance': case 'shunt': return { ...cmd, value: !cmd.value };
    case 'outputzone': return { ...cmd, value: cmd.value === 'activate' ? 'deactivate' : 'activate' };
    case 'inputzone': return { ...cmd, value: cmd.value === 'arm' ? 'disarm' : 'arm' };
    default: return null;   // a temporary override ends by itself
  }
}

module.exports = { parseCommand, commandEvent, buildRequest, reverseOf, labelOf, localStamp };
