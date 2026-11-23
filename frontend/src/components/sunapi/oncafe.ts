// AETHER_SUNAPI_LIMITS — SUNAPI (ONVIF access-control model) names -> what OnCAFE calls them.
// Kept in step with ONCAFE_MAP in backend/tools/nhp_limits.py (that one writes the "OnCAFE map" Excel sheet).
import { rowsOf, type Report } from './limitsDiff';

export type Confidence = 'confirmed' | 'field' | 'likely';
export interface OncafeEntry { key: string; term: string; what: string; conf: Confidence; note?: string; group: 'Access' | 'People' | 'Schedules' | 'Hardware' | 'Cloud' }
export const ONCAFE: OncafeEntry[] = [
  { key: 'AccessProfile.MaxCount', term: 'Access Levels', what: 'Access levels stored on the controller', conf: 'confirmed', note: 'SUNAPI AccessProfile = OnCAFE Access Level', group: 'Access' },
  { key: 'Credential.MaxAccessProfilesPerCredential', term: 'Access Levels per identity', what: 'Access levels one identity can hold (direct + through groups)', conf: 'field', note: 'Matches the OnCAFE field finding: an identity cannot hold more than 10 access levels', group: 'People' },
  { key: 'AccessProfile.MaxAccessPoliciesPerAccessProfile', term: 'Doors per Access Level', what: 'Door + schedule pairs inside one access level', conf: 'likely', group: 'Access' },
  { key: 'AccessProfile.MaxSchedulesPerAccessPolicy', term: 'Schedules per door in an Access Level', what: 'Schedules one door can use inside an access level', conf: 'likely', group: 'Access' },
  { key: 'AccessGroup.MaxCount', term: 'Cardholder Groups', what: 'Groups stored on the controller', conf: 'likely', note: 'SUNAPI AccessGroup', group: 'People' },
  { key: 'Credential.MaxGroupsPerCredential', term: 'Groups per identity', what: 'Cardholder groups one identity can be in', conf: 'likely', group: 'People' },
  { key: 'Credential.MaxCount', term: 'Identities / credentials', what: 'Credentials stored on the controller (one per cardholder)', conf: 'likely', group: 'People' },
  { key: 'CredentialMethod.MaxCount', term: 'Cards and PINs', what: 'Card numbers / PINs stored on the controller', conf: 'likely', note: 'SUNAPI CredentialMethod', group: 'People' },
  { key: 'Credential.MaxCredentialMethodsPerCredential', term: 'Cards / PINs per identity', what: 'Card numbers / PINs one identity can have', conf: 'likely', group: 'People' },
  { key: 'Schedule.MaxCount', term: 'Schedules', what: 'Schedules stored on the controller', conf: 'likely', group: 'Schedules' },
  { key: 'Schedule.MaxTimePeriodsPerDay', term: 'Time slots per day', what: 'Time periods in one schedule day', conf: 'likely', group: 'Schedules' },
  { key: 'Schedule.MaxSpecialDayGroups', term: 'Holiday groups', what: 'Holiday (special-day) groups', conf: 'likely', note: 'SUNAPI SpecialDayGroup', group: 'Schedules' },
  { key: 'Schedule.MaxDaysInSpecialDayGroup', term: 'Days per holiday group', what: 'Dates in one holiday group', conf: 'likely', group: 'Schedules' },
  { key: 'Door.MaxCount', term: 'Doors', what: 'Doors on this controller', conf: 'likely', group: 'Hardware' },
  { key: 'CredentialReader.MaxCount', term: 'Readers', what: 'Card readers on this controller', conf: 'likely', group: 'Hardware' },
  { key: 'AccessPoint.MaxCount', term: 'Door entry / exit points', what: 'Access points (a door with a reader direction)', conf: 'likely', note: 'SUNAPI AccessPoint', group: 'Hardware' },
  { key: 'AccessPoint.MaxAreas', term: 'Areas', what: 'Areas access points belong to', conf: 'likely', group: 'Hardware' },
  { key: 'SecurityLevel.MaxSecurityLevels', term: 'Reader security modes', what: 'Card only / card + PIN style levels', conf: 'likely', note: 'SUNAPI SecurityLevel', group: 'Hardware' },
  { key: 'AuthenticationProfile.MaxAuthenticationProfiles', term: 'Authentication profiles', what: 'Rules for which credential types a door needs', conf: 'likely', group: 'Hardware' },
  { key: '^accessprofile max objects$', term: 'Access Levels (measured)', what: 'Access levels actually stored before the controller refused', conf: 'confirmed', group: 'Access' },
  { key: '^accessschedule max objects$', term: 'Schedules (measured)', what: 'Schedules actually stored before the controller refused', conf: 'likely', group: 'Schedules' },
  { key: '^specialdaygroup max objects$', term: 'Holiday groups (measured)', what: 'Holiday groups actually stored before the controller refused', conf: 'likely', group: 'Schedules' },
  { key: '^accessgroup max objects$', term: 'Cardholder Groups (measured)', what: 'Groups actually stored before the controller refused', conf: 'likely', group: 'People' },
  { key: '^accessprofile Name max length$', term: 'Access Level name length', what: 'Longest access-level name stored unchanged', conf: 'confirmed', group: 'Access' },
  { key: '^accessschedule Name max length$', term: 'Schedule name length', what: 'Longest schedule name stored unchanged', conf: 'likely', group: 'Schedules' },
  { key: '^accessgroup Name max length$', term: 'Group name length', what: 'Longest group name stored unchanged', conf: 'likely', group: 'People' },
  { key: '^Simultaneous event monitor streams$', term: 'Event listeners', what: 'Event streams at once; the Cloud Connector uses one', conf: 'likely', group: 'Cloud' },
  { key: '^Door command -> event latency', term: 'Door event delay (controller part)', what: 'Command to event on the stream the Cloud Connector reads', conf: 'likely', note: 'Cloud delay adds to this', group: 'Cloud' },
];
export const confLabel: Record<Confidence, string> = { confirmed: 'Confirmed', field: 'Matches field finding', likely: 'Likely' };

export interface OncafeRow { term: string; what: string; value: string; num: number | null; source: string; sunapi: string; conf: Confidence; note?: string; group: OncafeEntry['group']; measured?: string; measuredNum?: number | null }
const toNum = (v: string) => { const n = parseFloat(String(v).replace(/^>=?/, '')); return /^\s*>?=?\s*-?[\d.]+\s*$/.test(v) && Number.isFinite(n) ? n : null; };

/** One row per OnCAFE term found in the report; a declared limit also carries its measured counterpart. */
export function oncafeRows(rep: Report | null): OncafeRow[] {
  const lim = rowsOf(rep, 'Limits').map(r => ({ name: String(r['Limit / property'] ?? ''), value: String(r.Value ?? ''), src: String(r.Source ?? '') }));
  const find = (key: string) => lim.find(l => (key.startsWith('^') ? new RegExp(key).test(l.name) : l.name.endsWith(key)));
  const rows: OncafeRow[] = [];
  for (const e of ONCAFE) {
    const l = find(e.key);
    if (!l) continue;
    rows.push({ term: e.term, what: e.what, value: l.value, num: toNum(l.value), source: ['capabilities', 'attributes.cgi'].includes(l.src) ? 'declared' : l.src, sunapi: l.name, conf: e.conf, note: e.note, group: e.group });
  }
  // pair "X (measured)" with the declared "X"
  for (const r of rows) {
    const m = rows.find(x => x.term === `${r.term} (measured)`);
    if (m) { r.measured = m.value; r.measuredNum = m.num; }
  }
  return rows;
}

/** SUNAPI accesscontrol object menu -> OnCAFE name (Push sequence steps). */
export const MENU_TERMS: Record<string, string> = {
  accessprofile: 'Access Levels', accessschedule: 'Schedules', specialdaygroup: 'Holiday groups', accessgroup: 'Cardholder Groups',
  accesspoint: 'Door entry / exit points', area: 'Areas', securitylevel: 'Reader security modes', authenticationprofile: 'Authentication profiles',
  credentialmethod: 'Cards and PINs', credential: 'Identities / credentials', customcredentialformat: 'Custom card formats', accessrule: 'Access rules',
};
export const menuTerm = (m: string) => MENU_TERMS[m] || m;
