// analytics/nhp.js — Hanwha NHP controller event feed (Cloud Connector on OpenSDK).
//
// NHP controllers push events to the Cloud Connector as multipart "Monitor Diff"
// responses, which the connector logs verbatim:
//   General : ParseMonitorDiffData : 368 => Monit Diff Event response payload :
//   {"EventStatus":[{"EventName":"AccessControl.DoorPhysicalState","Time":"2026-10-08T00:31:40.134+00:00",
//                    "Source":{"DoorToken":"1"},"Data":{"DoorPhysicalState":"Open"}}]}
//   --SamsungTechwin ...
// Each EventStatus entry carries the controller's own UTC timestamp (ms), so this
// feed plays the role the ASP SDK trace plays on Azure IC2 panels.
'use strict';

/** Map an NHP event to the RealTime eventType(s) the connector should publish. */
function cloudTypes(name, data = {}) {
  const n = String(name || '');
  const d = data || {};
  switch (n) {
    case 'AccessControl.DoorPhysicalState':
      return d.DoorPhysicalState === 'Open' ? ['open'] : d.DoorPhysicalState === 'Closed' ? ['closed'] : [];
    case 'AccessControl.DoorAlarmState':
      if (d.Status === 'DoorForcedOpen') return ['doorforcedopen'];
      if (d.Status === 'DoorHeldOpen' || /Held/i.test(d.Reason || '') && d.Status !== 'Normal') return ['dooropentoolong'];
      if (d.Status === 'Normal' && /Forced/i.test(d.Reason || '')) return ['doorforcedcleared'];
      if (d.Status === 'Normal' && /Held/i.test(d.Reason || '')) return ['doorheldcleared'];
      return [];
    case 'AccessControl.LockPhysicalState':
      return d.LockPhysicalState === 'Unlocked' ? ['unlocked'] : d.LockPhysicalState === 'Locked' ? ['locked'] : [];
    case 'AccessControl.REXActivated':
      return d.State === true ? ['rexactivated'] : d.State === false ? ['rexdeactivated'] : [];
    case 'AccessControl.AccessGranted': return ['accessgranted'];
    case 'AccessControl.AccessDenied': return ['accessdenied*'];
    case 'SystemEvent.CaseTampering': return d.State ? ['tamperactive'] : ['tampernormal'];
    default: return [];
  }
}

function sourceLabel(s = {}) {
  if (s.DoorToken != null) return `door ${s.DoorToken}`;
  if (s.AccessPointToken != null) return `access point ${s.AccessPointToken}`;
  if (s.ReaderIndex != null) return `reader port ${s.IOPort != null ? s.IOPort : '?'} idx ${s.ReaderIndex}`;
  if (s.Channel != null) return `channel ${s.Channel}`;
  if (s.ChangedConfigURI) return s.ChangedConfigURI;
  if (s.Token != null) return `${s.Type || 'token'} ${s.Token}`;
  return '';
}

/** Extract every EventStatus entry the connector logged. */
function extract(cc) {
  const out = [];
  for (const r of cc) {
    if (r.msg.indexOf('"EventStatus"') < 0) continue;
    const re = /\{"EventStatus":\[[\s\S]*?\]\}(?=\s*(?:--|$|\n))/g;
    let m;
    while ((m = re.exec(r.msg))) {
      let j;
      try { j = JSON.parse(m[0]); } catch { continue; }
      for (const e of j.EventStatus || []) {
        const t = Date.parse(e.Time);
        out.push({
          t: Number.isFinite(t) ? t : r.t, logT: r.t, hasTime: Number.isFinite(t),
          name: e.EventName || '', source: e.Source || {}, data: e.Data || {},
          types: cloudTypes(e.EventName, e.Data), src: sourceLabel(e.Source), file: r.file, line: r.line, fn: r.fn,
        });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

module.exports = { extract, cloudTypes, sourceLabel };
