// analytics/playbook.js — "Likely cause" + troubleshooting steps for every finding.
//
// Each entry returns { cause, confidence, owner, steps[] }:
//   cause       one or two sentences — the most probable explanation for THIS bundle
//   confidence  'likely' (evidence in the bundle points here) · 'possible' (common cause, not proven)
//   owner       'Field / T/S' (site, wiring, network, config) · 'Engineering' (firmware/cloud defect)
//               · 'Field / T/S → Engineering' (T/S checks first, escalate if it persists)
//   steps       ordered checks, most likely first
// Context-aware entries look at other findings and summary data from the same scan.
'use strict';

const { fmtDur } = require('./time');

const T = 'Field / T/S', E = 'Engineering', TE = 'Field / T/S → Engineering';
const near = (a, b, ms) => a != null && b != null && Math.abs(a - b) <= ms;
const anyNear = (f, other, ms) => other && (other.samples || []).some(s => (f.samples || []).some(x => near(x.t, s.t, ms)));

const MQTT_CODE_STEPS = {
  7: ['Check the site WAN/Internet link at these times (ISP outage, router reboot, Wi-Fi/cellular backup failover).',
    'Look for firewall/NAT idle timeouts shorter than the MQTT keepalive on outbound 443 to messaging.*.hanwhavision.cloud.',
    'If the network was healthy, collect the bundle and the broker host/time and escalate as a broker-side disconnect.'],
  14: ['Socket error from the OS: check DHCP lease renewals, link flaps and DNS failures at these times.',
    'Confirm the controller has a static IP or a long DHCP lease and working DNS servers.',
    'Repeated code 14 with a healthy network → escalate with the bundle.'],
  19: ['Keepalive timeout: the broker stopped answering. Check WAN latency/packet loss and any SSL-inspecting proxy.',
    'Allow outbound 443 to messaging.*.hanwhavision.cloud without TLS interception.',
    'If many controllers dropped at once, it is cloud-side — escalate.'],
  11: ['Authentication rejected: the device credentials are no longer valid.', 'Re-claim the controller in the cloud portal, or factory-reset the Cloud Connector registration.'],
  8: ['TLS failure: check controller date/time (NTP) first — a wrong clock breaks certificates.', 'Check for a TLS-inspecting proxy/firewall.', 'Persisting with correct time → escalate (certificate bundle on the device).'],
};

/** id (exact) or prefix → (finding, ctx, all findings) => playbook */
const RULES = [
  // ── cloud ────────────────────────────────────────────────────────────────
  [/^cloud\.mqtt\.disconnect\.(\d+)$/, (f, ctx, all, m) => {
    const code = +m[1];
    if (code === 0) return { cause: 'Clean disconnect requested by the connector (restart, broker switch or re-claim). Not a fault on its own.', confidence: 'likely', owner: T, steps: ['Nothing to do unless it is followed by a long outage.'] };
    const marks = all.filter(x => ['cloud.network-drop', 'panel.keepalive', 'delivery.ntp'].includes(x.id)).flatMap(x => x.samples.map(s => s.t));
    const hits = f.samples.filter(s => marks.some(t => near(s.t, t, 10 * 60000))).length;
    const local = hits > 0 && hits === f.samples.length;
    const some = hits > 0 && !local;
    return {
      cause: local
        ? `Every one of these drops coincides with the controller losing its own network (network monitor / SDK keepalive within minutes), so this is a local network or WAN outage, not the broker.`
        : some ? `${hits} of ${f.samples.length} drops coincide with the controller losing its own network (local/WAN outage). The others had no local alarm — ${code === 14 ? 'likely a link flap, DHCP renewal or DNS failure' : code === 19 ? 'likely WAN latency/loss or a proxy holding the connection' : 'most often a router/firewall dropping the long-lived TLS connection or a short ISP blip'}.`
        : code === 7 ? 'Connection lost without a local network alarm — most often a router/firewall dropping the long-lived TLS connection (NAT/idle timeout) or a short ISP blip.'
          : code === 19 ? 'The broker stopped answering keepalives — WAN latency/loss or a proxy holding the connection.'
            : code === 14 ? 'Socket-level error from the controller OS — link flap, DHCP renewal or DNS failure.'
              : 'MQTT client error — see the code meaning in the title.',
      confidence: local ? 'likely' : 'possible', owner: local || some ? T : TE,
      steps: MQTT_CODE_STEPS[code] || ['Correlate the times with network events on site.', 'Escalate with the bundle if it repeats on a healthy network.'],
    };
  }],
  ['cloud.outage', (f) => ({
    cause: f.samples.some(s => /until end of log/.test(s.text)) ? 'The controller never reconnected before the log ended — it may still be offline.' : 'The cloud connection was down long enough for events to queue on the controller; they are sent when it reconnects.',
    confidence: 'likely', owner: T,
    steps: ['Check whether the site lost Internet at these times (router/ISP logs).', 'Confirm queued events arrived in the cloud after reconnect (event history around the outage).', 'If outages repeat daily at the same time, look for a scheduled router reboot or firewall policy.'],
  })],
  ['cloud.reconnect-storm', () => ({
    cause: 'Repeated connect/disconnect within an hour usually means an unstable link (Wi-Fi, PoE/power dips) or a firewall resetting long TLS sessions.',
    confidence: 'possible', owner: T,
    steps: ['Check physical link: cable, switch port errors, PoE budget.', 'Look for firewall session limits/IPS resets on outbound 443.', 'Check controller uptime around the storm (did it reboot?).'],
  })],
  ['cloud.token-expired', () => ({
    cause: 'The MQTT token expired before the connector refreshed it — typically after a long offline period or a wrong controller clock.',
    confidence: 'possible', owner: TE,
    steps: ['Verify NTP sync and controller time.', 'If the controller was offline when the token expired this is expected and self-heals.', 'Repeated expiry while online → escalate (token refresh timing).'],
  })],
  ['cloud.publish-error', () => ({
    cause: '"Invalid arguments" publish errors right after first connect to messaging.platform happen during claim/first boot before topics are assigned.',
    confidence: 'possible', owner: E,
    steps: ['If it only appears once at claim time, ignore.', 'If it repeats after the device is claimed, escalate with the bundle (connector publishing to an unassigned topic).'],
  })],
  ['cloud.http-token-retry', () => ({
    cause: 'The device API token was stale when the connector tried to publish artifacts; it slept and retried. Normal once a day; frequent retries point to clock or cloud-auth trouble.',
    confidence: 'possible', owner: TE,
    steps: ['Check NTP sync.', 'If retries fail repeatedly (no success after), escalate with the bundle.'],
  })],
  ['cloud.network-drop', () => ({
    cause: 'The connector\'s own network monitor saw the cloud as unreachable — site network or Internet loss.',
    confidence: 'likely', owner: T,
    steps: ['Check the controller\'s network link and the site Internet at these times.', 'Check DNS resolution of *.hanwhavision.cloud from the site.', 'Correlate with MQTT disconnect findings.'],
  })],
  ['cloud.http-error', () => ({ cause: 'Cloud API calls returned errors.', confidence: 'possible', owner: TE, steps: ['Open the raw lines for the response code.', '4xx: check claim/credentials. 5xx: cloud-side — escalate.'] })],
  ['cloud.broker-change', () => ({ cause: 'Normal at claim: the controller first talks to messaging.platform, then is moved to its tenant broker.', confidence: 'likely', owner: T, steps: ['Nothing to do unless it switches back and forth repeatedly.'] })],
  ['cloud.claim', () => ({ cause: 'The device was claimed (or re-claimed) to an organization.', confidence: 'likely', owner: T, steps: ['Confirm the re-claim was intentional — it resets cloud configuration sync.'] })],

  // ── door ─────────────────────────────────────────────────────────────────
  ['door.forced', (f, ctx, all) => {
    const allForced = all.find(x => x.id === 'door.all-forced');
    return {
      cause: allForced ? 'Nearly every door open is forced, so the controller never unlocks before the door opens. On an Aether rig this is the door contact being driven without a card/REX first; on a real door the lock is not engaging or the DPS is wired/configured wrong.'
        : 'The door opened without a grant, REX or unlock. Either someone pushed/pulled the door, the lock did not hold, or a REX device is not wired to the controller.',
      confidence: allForced ? 'likely' : 'possible', owner: T,
      steps: ['If this is an Aether test: check the workflow sends a card or REX before driving the DPS.', 'Verify the lock holds when locked (mechanical/strike power).', 'Check DPS contact type (NO/NC) in the I/O config matches the wiring.', 'If people exit with a non-wired REX/crash bar, wire it to the REX input or shunt the alarm.'],
    };
  }],
  ['door.all-forced', () => ({
    cause: 'Door opens are never preceded by a valid unlock. Typical of a test rig toggling the door contact, or of a DPS whose open/closed sense is inverted.',
    confidence: 'likely', owner: T,
    steps: ['Aether: include a card read or REX step before the DPS step.', 'Real door: check DPS contact type (normallyClosed vs normallyOpen) against the wiring.', 'Watch the door: does "open" fire when it actually closes? → inverted DPS.'],
  })],
  ['door.held', (f, ctx) => {
    const d = Object.values(((ctx.p.cfg['doors.json'] || {}).json) || {})[0] || {};
    const m = f.metrics && f.metrics.stillOpenAfterAlarmMs;
    const quick = m && m.p50 != null && m.p50 < 20000;
    return {
      cause: quick ? `Doors are closed soon after the alarm (median ${fmtDur(m.p50)}), so the held-open time (${d.shortHeldOpenTime || '?'} s) is likely too short for normal traffic.`
        : `Doors stay open long after the alarm (median ${m ? fmtDur(m.p50) : '?'}), so they are being propped/left open, or the closer is not pulling them shut.`,
      confidence: 'possible', owner: T,
      steps: quick ? ['Raise the held-open time on the door, or use the long held-open time for ADA/deliveries.', 'Check the door closer speed.']
        : ['Check the door closer and latch — does the door close on its own?', 'Check for a propped door / missing door-hold policy.', 'Confirm the DPS reports "closed" when the door is really closed.'],
    };
  }],
  ['door.held-timer', () => ({ cause: 'The held-open alarm fires at a different time than configured — the configuration on the controller differs from the cloud, or the timer starts at a different event.', confidence: 'possible', owner: TE, steps: ['Compare the door\'s held-open time in the cloud and on the controller (resync the controller).', 'If they match and timing still differs, escalate with the samples.'] })],
  ['door.unlock-no-cause', () => ({ cause: 'An unlock with no grant, REX or schedule nearby is usually a remote/manual unlock from the cloud or an operator, logged at a level not in this bundle — or an unexpected relay drive.', confidence: 'possible', owner: TE, steps: ['Check the cloud audit/event history for remote unlocks at these times.', 'Check schedules that change at these times.', 'If neither explains it, escalate — unexpected unlocks are a security issue.'] })],
  ['door.strike-long', () => ({ cause: 'The strike stayed released longer than its configured time while the door stayed closed — a lingering schedule/override, or relock waiting for an event that never came.', confidence: 'possible', owner: TE, steps: ['Check active schedules/overrides on the door at these times.', 'Check relock behavior setting (relock on close vs. on grant time).', 'Escalate if no schedule explains it.'] })],
  ['door.denied', () => ({ cause: 'Credentials were refused — wrong PIN, expired/unknown card or outside schedule.', confidence: 'possible', owner: T, steps: ['Open the raw lines to see the denial reason.', 'Check the user\'s access profile and schedule in the cloud.'] })],
  ['door.denied-burst', () => ({ cause: 'Several denials at one door within a minute — someone guessing PINs, a confused user, or an Aether test sending bad credentials.', confidence: 'possible', owner: T, steps: ['If not an Aether test, review camera footage for that door/time.', 'Consider lockout after N failed PINs.'] })],
  ['door.rex-stuck', () => ({ cause: 'REX stayed active — a stuck button/PIR, a shorted wire, or the REX contact type inverted.', confidence: 'possible', owner: T, steps: ['Check the REX device and wiring.', 'Verify the REX contact type (NO/NC) in the I/O config.'] })],
  ['door.sequence', (f) => ({
    cause: /local time — check the schedules/.test(f.detail) ? 'The repeats happen at the same clock time every day, so a schedule change re-publishes the current door state.' : 'An intermediate door state change was missed or published twice.',
    confidence: /local time — check the schedules/.test(f.detail) ? 'likely' : 'possible', owner: /local time/.test(f.detail) ? E : TE,
    steps: ['Check schedules that fire at that time on this door.', 'If the cloud shows duplicate open events, report it as a connector issue with these samples.'],
  })],
  ['door.left-open', () => ({ cause: 'The last door state in the log is "open".', confidence: 'possible', owner: T, steps: ['Check the door now — it may still be open or the DPS is stuck open.'] })],
  ['door.state-jump', () => ({ cause: 'The access-point state machine skipped a state — an event was lost between controller and connector.', confidence: 'possible', owner: E, steps: ['Check the Panel link tab around these times for gaps or reconnects.', 'Escalate with the samples if no link problem explains it.'] })],

  // ── delivery ─────────────────────────────────────────────────────────────
  ['delivery.publish-lag', (f, ctx, all) => {
    const out = all.find(x => x.id === 'cloud.outage' || x.id === 'cloud.network-drop');
    return { cause: anyNear(f, out, 30 * 60000) ? 'Slow publishes cluster around a cloud outage — events were queued and sent on reconnect.' : 'The connector was slow to publish — controller CPU load, a large sync running, or a slow uplink.', confidence: out ? 'likely' : 'possible', owner: TE, steps: ['Check whether a full sync or firmware download was running at the same time.', 'Check uplink bandwidth/latency.', 'Persistent multi-second lag on an idle controller → escalate.'] };
  }],
  ['delivery.clock-skew', () => ({ cause: 'Event timestamps are ahead of the log clock — the controller clock and the connector disagree, or timezone.json does not match.', confidence: 'possible', owner: T, steps: ['Check NTP on the controller.', 'Check the timezone set on the controller vs timezone.json.'] })],
  ['delivery.unpublished', () => ({ cause: 'Door transitions without a cloud event are often filtered by door settings (ignoreAccessEvents / showRexActivatedEvents); otherwise events were dropped.', confidence: 'possible', owner: TE, steps: ['Check the door\'s event filter settings in the cloud.', 'If filters are off, escalate with the samples.'] })],
  ['delivery.offline-growth', (f) => ({ cause: f.sev === 'info' ? 'The offline event DB in the bundle is empty, so the "rows" number is a row ID, not a backlog.' : 'Events are written to the offline store and not removed — the cloud may not be acknowledging them.', confidence: f.sev === 'info' ? 'likely' : 'possible', owner: f.sev === 'info' ? T : E, steps: f.sev === 'info' ? ['Nothing to do.'] : ['Check the cloud for missing events in this period.', 'Escalate with offlineEvnt.db from the bundle.'] })],
  ['delivery.log-gap', () => ({ cause: 'No log lines at all for hours — the controller was powered off, rebooted or the connector hung.', confidence: 'possible', owner: T, steps: ['Check controller uptime and power at those times.', 'Check for a CloudConnector restart right after the gap.'] })],
  ['delivery.heartbeat', () => ({ cause: 'The hourly scheduled sync did not run — scheduler stalled, process restarted or device was down.', confidence: 'possible', owner: TE, steps: ['Check for restarts or log gaps at the same time.', 'Repeated misses on a running device → escalate.'] })],
  ['delivery.clock-jump', () => ({ cause: 'Time stepped backwards — NTP corrected a drifting clock or the RTC was reset at boot.', confidence: 'likely', owner: T, steps: ['Confirm NTP is reachable from the controller.', 'Check the RTC battery if the clock resets after power loss.'] })],
  ['delivery.restart', () => ({ cause: 'The Cloud Connector restarted — reboot, update or crash.', confidence: 'possible', owner: TE, steps: ['Check the audit log for an update/reboot at that time.', 'Restarts without a reason → escalate with the bundle.'] })],
  ['delivery.app-starts', () => ({ cause: 'Starts minutes apart are installs/updates or a crash loop; starts weeks apart are normal reboots.', confidence: 'possible', owner: TE, steps: ['Match each start with a firmware/connector version change in the audit log.'] })],
  ['delivery.ntp', () => ({ cause: 'The controller cannot reach its NTP server.', confidence: 'likely', owner: T, steps: ['Allow UDP 123 outbound.', 'Configure a reachable NTP server.'] })],
  ['delivery.sync-slow', () => ({ cause: 'Full syncs taking over 30 s — large credential count or slow cloud responses.', confidence: 'possible', owner: TE, steps: ['Check how many credentials/schedules the controller holds.', 'Escalate if small sites sync slowly.'] })],
  ['delivery.panel-to-cloud-slow', () => ({ cause: 'Some controller events took over 2 s to reach the cloud — queued behind a sync or a reconnect.', confidence: 'possible', owner: TE, steps: ['Check whether a sync or reconnect was running at those times.'] })],

  // ── panel link ───────────────────────────────────────────────────────────
  ['panel.keepalive', () => ({ cause: 'The controller firmware stopped answering the connector for a few seconds — controller busy (sync/firmware) or an internal link hiccup.', confidence: 'possible', owner: E, steps: ['Check what the controller was doing (sync, firmware) at that time.', 'Repeated misses → escalate with the aspsdk logs.'] })],
  ['panel.reconnect', () => ({ cause: 'The connector re-opened its SDK session to the controller firmware — normal at boot or after an IP change.', confidence: 'possible', owner: T, steps: ['Check whether these match boots/IP changes; extra reconnects → escalate.'] })],
  ['panel.ip-change', () => ({ cause: 'The controller got a new IP address from DHCP.', confidence: 'likely', owner: T, steps: ['Give the controller a DHCP reservation or static IP so integrations do not break.'] })],
  ['panel.event-gap', () => ({ cause: 'Large serial jumps near a reconnect mean events may have been lost between controller and connector.', confidence: 'possible', owner: E, steps: ['Compare controller event history with the cloud for these times.', 'Escalate with aspsdk logs.'] })],
  ['panel.serial-replay', () => ({ cause: 'After reconnecting, the controller re-sent events the connector had not acknowledged — the cloud may show duplicates.', confidence: 'likely', owner: E, steps: ['Check the cloud for duplicate events at these times; report if duplicates appear.'] })],
  ['panel.event-unacked', () => ({ cause: 'The connector did not acknowledge some events in time — they stay queued and are replayed.', confidence: 'possible', owner: E, steps: ['Usually harmless in small numbers; many → escalate.'] })],
  ['panel.no-reply', () => ({ cause: 'Commands to the controller went unanswered — controller busy or link problem.', confidence: 'possible', owner: E, steps: ['Check for keepalive misses at the same time.', 'Escalate with aspsdk logs.'] })],
  ['panel.slow-reply', () => ({ cause: 'Controller replies slower than 1 s — heavy load during sync.', confidence: 'possible', owner: E, steps: ['Note if it coincides with syncs; escalate if constant.'] })],
  ['panel.malformed', () => ({ cause: 'Frames with the wrong length — trace truncation or a protocol bug.', confidence: 'possible', owner: E, steps: ['Escalate with the raw frames.'] })],
  ['panel.unknown-codes', () => ({ cause: 'SDK codes the decoder does not know yet (decoder built without a spec).', confidence: 'likely', owner: E, steps: ['No site action. Share the SDK command/event list to name them.'] })],
  ['panel.sdk-errors', () => ({ cause: 'Errors in the SDK trace itself.', confidence: 'possible', owner: E, steps: ['Open the raw lines; escalate with aspsdk logs.'] })],
  ['panel.event-not-published', () => ({ cause: 'Controller events with no matching cloud event — filtered by door settings or dropped by the connector.', confidence: 'possible', owner: TE, steps: ['Check door event filters.', 'Escalate with samples if filters are off.'] })],
  ['panel.nhp-feed-late', () => ({ cause: 'The NHP delivered events to the connector late — a re-subscribe after reconnect or a busy controller.', confidence: 'possible', owner: TE, steps: ['Check for reconnects/syncs at those times.'] })],
  ['panel.nhp-clock', () => ({ cause: 'The NHP clock is ahead of the connector log clock, or timezone.json does not match.', confidence: 'possible', owner: T, steps: ['Check NTP and timezone on the NHP.'] })],
  ['panel.nhp-anon-grant', () => ({ cause: 'Anonymous grants (REX / free access) are reported by the NHP but not forwarded as accessgranted — likely by design (the cloud gets rexactivated).', confidence: 'possible', owner: E, steps: ['Confirm with Engineering whether anonymous grants should appear in cloud access history.'] })],
  ['panel.nhp-not-published', () => ({ cause: 'The NHP reported events that never reached the cloud.', confidence: 'likely', owner: E, steps: ['Check the cloud event history at those times.', 'Escalate with the samples.'] })],
  ['panel.reader-offline', (f) => ({
    cause: /scheduled re-init/.test(f.detail) ? 'Sub-second reader drops at the same time every night — the controller re-initializes readers during its nightly sync/maintenance. Not a wiring fault.'
      : 'The reader lost communication with the controller — loose RS-485/Wiegand wiring, reader power, or OSDP address/baud mismatch.',
    confidence: /scheduled re-init/.test(f.detail) ? 'likely' : 'possible', owner: /scheduled re-init/.test(f.detail) ? E : T,
    steps: /scheduled re-init/.test(f.detail) ? ['No site action. Mention to Engineering if the nightly drop should be suppressed.']
      : ['Check reader power (voltage at the reader under load).', 'Check RS-485 wiring, termination and shield; Wiegand D0/D1.', 'Check OSDP address and baud match the controller config.'],
  })],

  // ── config ───────────────────────────────────────────────────────────────
  ['config.version-drift', () => ({ cause: 'Config snapshots show different firmware versions — a stale system.conf/commonProperties after an update.', confidence: 'likely', owner: E, steps: ['Check the version the cloud shows for this controller.', 'If wrong, reboot the controller; persisting → escalate.'] })],
  ['config.fw-change', () => ({ cause: 'Firmware/connector was updated during the audit history.', confidence: 'likely', owner: T, steps: ['Match problem start dates with these updates.'] })],
  ['config.reset', () => ({ cause: 'The controller did a partial reset / module de-init — usually a re-claim or a config push.', confidence: 'possible', owner: T, steps: ['Confirm a re-claim or reset was performed intentionally.'] })],
  ['config.archives', () => ({ cause: 'Older log snapshots kept on the controller.', confidence: 'likely', owner: T, steps: ['Use them to see when a problem first appeared.'] })],
  ['config.sync-frequent', () => ({ cause: 'Full syncs more than 4×/day — reconnects or frequent cloud-side changes trigger them.', confidence: 'possible', owner: TE, steps: ['Match syncs with reconnects; many syncs without reconnects → escalate.'] })],
  ['config.sync-step-slow', () => ({ cause: 'Individual sync steps over 5 s.', confidence: 'possible', owner: E, steps: ['Note which step (raw lines); escalate if constant.'] })],

  // ── security ─────────────────────────────────────────────────────────────
  [/^security\.leak\./, (f) => ({
    cause: `The Cloud Connector writes this secret to its debug log${/archived/.test(f.detail) ? ' (also in older archived snapshots)' : ''}. It is a logging defect, not a breach by itself — but anyone holding the bundle can use the secret while it is valid.`,
    confidence: 'likely', owner: E,
    steps: ['Treat this bundle as confidential; do not attach it to public tickets.', /password/i.test(f.title) ? 'Change the controller/MQTT password if the bundle left your team.' : 'Tokens expire on their own; rotate if the bundle was shared widely.', 'Report to Engineering to mask the field in the connector log.'],
  })],
  ['security.bundle-creds', () => ({ cause: 'Credential files are part of the exported bundle.', confidence: 'likely', owner: E, steps: ['Handle the bundle as confidential.'] })],
  ['security.case-tamper', () => ({ cause: 'The controller enclosure tamper switch opened — someone opened the cabinet, or the tamper switch is not seated.', confidence: 'possible', owner: T, steps: ['Confirm whether the enclosure was opened (service visit).', 'If not, check the tamper switch/cover alignment.'] })],

  // ── statistical ──────────────────────────────────────────────────────────
  ['stat.rare', () => ({ cause: 'One-off messages — usually state changes; occasionally the first sign of a problem.', confidence: 'possible', owner: T, steps: ['Skim the list with Show raw for anything unexpected.'] })],
  ['stat.spike', () => ({ cause: 'An hour with far more events than usual — a test run, a door left cycling, or a stuck input.', confidence: 'possible', owner: T, steps: ['Check what happened at that hour (Timeline tab).'] })],
];

// Known message titles from detectors.js KNOWN (config.sig.*)
const BY_TITLE = [
  [/Automation lookup on every event/, () => ({ cause: 'No automations are configured, so every event logs an empty trigger lookup. Harmless noise.', confidence: 'likely', owner: T, steps: ['Nothing to do.'] })],
  [/Door schedule evaluation logged at ERROR/, () => ({ cause: 'Normal schedule evaluation logged at the wrong level.', confidence: 'likely', owner: E, steps: ['Nothing to do on site.'] })],
  [/floor that is not configured/, (f, ctx) => ({
    cause: `Access profiles include floor permissions but ${((ctx.p.cfg['elevator.json'] || {}).raw || '').trim() === '{}' ? 'no elevator is configured on this controller (elevator.json is empty)' : 'the floor is not on this controller'}.`,
    confidence: 'likely', owner: T, steps: ['Remove the floor from the access profiles synced to this controller, or configure the elevator on it.'],
  })],
  [/Panel object missing in sync payload/, () => ({ cause: 'The cloud sync carried no panel section for this controller.', confidence: 'possible', owner: E, steps: ['Re-sync the controller from the cloud; persisting → escalate.'] })],
  [/unknown I\/O port/, () => ({ cause: 'A reader setting references an I/O port not configured on this controller — reader config out of step with I/O config.', confidence: 'likely', owner: T, steps: ['Open the reader settings in the cloud and re-select its I/O port, then re-sync.'] })],
  [/Zone configuration could not be saved/, () => ({ cause: 'The zone changed state but the controller could not persist it (storage or permission problem).', confidence: 'possible', owner: E, steps: ['Check free storage on the controller.', 'Escalate with the samples.'] })],
  [/input that is not in the I\/O configuration/, () => ({ cause: 'The controller reports an alarm input (often channel 0) that is not set up in the cloud, so the connector drops its events. Usually an unused input that is wired or floating, or an Aether rig driving it.', confidence: 'likely', owner: T, steps: ['Configure the input in the cloud, or remove/terminate the wiring on that channel.', 'On an Aether rig: check which relay drives this input.'] })],
  [/reader index the connector does not know/, () => ({ cause: 'The controller reports state for a reader position that is not configured (e.g. ReaderIndex 3).', confidence: 'likely', owner: T, steps: ['Check the reader ports configured on the controller vs the cloud; remove the extra reader or configure it.'] })],
  [/Access event without credential details/, () => ({ cause: 'An anonymous grant (REX / free access) has no cardholder data — expected.', confidence: 'likely', owner: T, steps: ['Nothing to do unless it happens on card reads.'] })],
  [/AWS CA certificate missing/, () => ({ cause: 'The CA bundle was not readable at start-up, but MQTT connected afterwards — a start-up race, harmless.', confidence: 'possible', owner: E, steps: ['If TLS errors follow, reinstall the Cloud Connector package.'] })],
  [/Zone configuration file absent/, () => ({ cause: 'No zones are configured, so the zone files do not exist.', confidence: 'likely', owner: T, steps: ['Nothing to do.'] })],
  [/Failed to get Sync Object Detail/, () => ({ cause: 'Cloud backend error 8335 while fetching a sync object.', confidence: 'likely', owner: E, steps: ['Check the next sync succeeded; repeated 8335 → escalate (cloud-side).'] })],
  [/invalid backend response/, () => ({ cause: 'Temporary cloud response problem during sync; the connector retried.', confidence: 'possible', owner: E, steps: ['Nothing to do if later syncs succeed.'] })],
  [/Entitlement\/license artifacts/, () => ({ cause: 'The connector re-applies its license/entitlement daily.', confidence: 'likely', owner: T, steps: ['Nothing to do.'] })],
  [/Camera platform package update pending/, () => ({ cause: 'A platform package update is waiting.', confidence: 'likely', owner: T, steps: ['Apply pending updates during a maintenance window.'] })],
  [/couldn'?t resolve host|getaddrinfo|Temporary failure in name resolution/i, () => ({ cause: 'DNS failed — the controller could not resolve the cloud host names.', confidence: 'likely', owner: T, steps: ['Check DNS servers on the controller (DHCP or static).', 'Test resolving *.hanwhavision.cloud from the site network.'] })],
  [/Error opening file: .*(automation|Zone)|Failed to get file content/i, () => ({ cause: 'A config file the connector looks for does not exist yet — nothing of that kind (automations / zones) is configured.', confidence: 'likely', owner: T, steps: ['Nothing to do unless that feature is configured and still failing.'] })],
  [/stw-cgi|SUNAPI|HTTP GET request failed|Failed get child device API|Failed monitordiff request|Subscription Event Section|parse and check subscription events/i, () => ({ cause: 'The connector could not talk to the NHP\'s local web API (SUNAPI / stw-cgi) — the controller\'s web service was busy or still starting, typically right after boot or a firmware update.', confidence: 'possible', owner: TE, steps: ['Check whether these lines sit right after a boot or update (audit log).', 'If they continue minutes after boot, reboot the controller; persisting → escalate.'] })],
  [/request not supported.*GetSDK_APP/i, () => ({ cause: 'The NHP firmware does not support a request the connector made — connector and firmware versions out of step.', confidence: 'likely', owner: E, steps: ['Update the NHP firmware and Cloud Connector to a matching release.'] })],
  [/'channels' not found|Invalid payload description|ioConfig is not found|Null pointer received/i, () => ({ cause: 'An incomplete payload during first setup/sync (I/O or channel config not there yet).', confidence: 'possible', owner: E, steps: ['If it only happens at setup, ignore.', 'If it repeats on a configured controller, escalate with the samples.'] })],
  [/Announce response requesting partial reset/i, () => ({ cause: 'The cloud told the controller to partially reset — happens on re-claim or org change.', confidence: 'likely', owner: T, steps: ['Confirm a re-claim/org move happened then.'] })],
  [/door is not assigned, so ignoring the event/i, () => ({ cause: 'Events from an I/O point not assigned to any door were ignored.', confidence: 'likely', owner: T, steps: ['Assign the input to a door, or ignore if it is unused.'] })],
  [/Sleep for # before next try|Always schedule is default/i, () => ({ cause: 'Normal retry/back-off or protected default schedule — informational.', confidence: 'likely', owner: T, steps: ['Nothing to do.'] })],
  [/Failed to parse and check device artifacts/i, () => ({ cause: 'The device artifacts from the cloud could not be parsed — usually during first claim/download.', confidence: 'possible', owner: E, steps: ['If it repeats on a claimed controller, escalate.'] })],
  [/token api is failed|Auth API failed|Token api response parsed fail/i, () => ({ cause: 'The controller could not get a cloud auth token — usually DNS/Internet down at the time.', confidence: 'possible', owner: T, steps: ['Check Internet/DNS at those times.', 'If the network was fine, escalate.'] })],
];

const GENERIC = (f) => ({
  cause: `Unclassified ${/^WARN/.test(f.title) ? 'warning' : 'error'} from the connector — no playbook entry yet.`,
  confidence: 'possible', owner: TE,
  steps: ['Use Show raw to read the line in context.', 'Check whether it lines up in time with other findings.', 'If it repeats or matches a symptom, escalate with the samples.'],
});

function explain(findings, ctx) {
  for (const f of findings) {
    let pb = null;
    for (const [k, fn] of RULES) {
      const m = typeof k === 'string' ? (f.id === k ? [k] : null) : k.exec(f.id);
      if (m) { pb = fn(f, ctx, findings, m); break; }
    }
    let fromRules = !!pb;
    if (!pb && /^config\.sig\./.test(f.id)) {
      const hit = BY_TITLE.find(([rx]) => rx.test(`${f.title} ${f.detail}`));
      pb = hit ? hit[1](f, ctx, findings) : GENERIC(f);
    }
    if (!pb && /^internal\./.test(f.id)) pb = { cause: 'A scanner rule failed on this bundle.', confidence: 'likely', owner: E, steps: ['Send the bundle so the rule can be fixed.'] };
    if (pb) {
      if (!fromRules && f.fix && !pb.steps.includes(f.fix)) pb.steps = [...pb.steps, f.fix];   // rule playbooks already cover the old hint
      if (/archived logs/.test(f.title)) pb.cause = `(Older archived logs.) ${pb.cause}`;
      f.playbook = pb;
    }
  }
  return findings;
}

module.exports = { explain };
