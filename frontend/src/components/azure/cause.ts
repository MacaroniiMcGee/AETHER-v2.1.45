// AETHER_AZURE_DEBUG — "what's the problem?" filter (AZURE-15).
// Type a reported problem ("Controller offline") or any words ("dns", "power loss", "O8 NAK") and the scan is cut
// down to the alerts behind it, with their log lines merged into one time line.
// Known problems come from Log Analytics' symptom catalogue (report.symptoms; findings carry .symptoms tags) plus a
// few Azure-only ones; anything else is matched word by word (with synonyms) against the alerts and their log lines.
import type { Finding, Scan } from './api';
import { rehop } from './timeRange';

export interface Topic { id: string; label: string; desc?: string; checklist?: string[]; aliases?: string[] }
export interface LogLine { t: number | null; text: string; file?: string; line?: number; src: string; sev?: string; kind: 'alert' | 'startup' | 'status' }
export interface CauseResult { topic: Topic | null; words: string[]; scan: Scan; lines: LogLine[]; matched: number; total: number }

// Extra names people use for the catalogue entries, and the Azure-only topics.
const ALIASES: Record<string, string[]> = {
  offline: ['controller offline', 'ic2 offline', 'cloud offline', 'device offline', 'disconnected', 'not online', 'goes offline', 'offline'],
  connect: ['cannot connect', 'not claimed', 'claim', 'onboarding', 'not onboarding', 'register', 'tls', 'certificate'],
  reader: ['reader offline', 'reader not reading', 'card not read', 'osdp reader', 'wiegand'],
  events: ['events missing', 'events late', 'missing events', 'no events'],
  config: ['sync failed', 'settings not applied', 'config not applied', 'changes not applied', 'sync'],
  denied: ['access denied', 'valid user denied', 'card denied'],
  unknowncred: ['unknown card', 'unknown credential'],
  unlock: ['door unlocks', 'unlocked', 'door unlock'],
  opens: ['forced', 'held open', 'door forced', 'door held'],
  security: ['tamper', 'security'],
};
const EXTRA: Topic[] = [
  { id: 'board', label: 'Expansion board offline', desc: 'RI2M / RI4 / IO168 / O8 / XO8 panel offline, NAKs or not working',
    aliases: ['board offline', 'panel offline', 'expansion offline', 'expansion board', 'io168', 'ri4', 'ri2m', 'o8', 'xo8', 'i16', 'rs-485', 'rs485', 'nak'],
    checklist: ['Check the board address is unique on its COM port and matches OnCAFE.', 'Check RS-485 wiring, termination, ground and board power.', 'Check the board firmware and model match what OnCAFE expects (O8 vs XO8, Gen3 vs Gen4).', 'NAK = the board answered but refused; Connection = it stopped answering.'] },
  { id: 'power', label: 'Power loss / restart', desc: 'Controller rebooted, lost power or the Cloud Connector restarted',
    aliases: ['power loss', 'power cut', 'power', 'reboot', 'restart', 'rebooted', 'crash', 'coredump'],
    checklist: ['Compare the restart times with site power events.', 'Check the controller came back to CLAIMED after each start.', 'A gap in the logs before a start usually means power was off.'] },
  { id: 'network', label: 'Network / DNS change', desc: 'IP, DHCP/static, DNS or LAN changes',
    aliases: ['network', 'dns', 'dhcp', 'static ip', 'ip change', 'lan', 'lookup', 'getaddrinfo', 'network change'],
    checklist: ['Check the controller got an address and gateway after the change.', 'Check names resolve inside the Cloud Connector (getaddrinfo / Lookup error lines).', 'Firmware 1.23.3+ re-pushes DNS into the Cloud Connector after a network change.'] },
];

// Alerts that belong to a topic but are not tagged by Log Analytics (Azure checks, CC error signatures).
const TOPIC_RX: Record<string, { ids?: RegExp; text?: RegExp }> = {
  offline: { ids: /^(cloud\.(not-claimed|ntp|files|claim-state|publish-error)|config\.reset)$/, text: /TCP (test|connection)( ultimately)? failed|Network is unreachable|MQTT Is Not Connected|Lookup error|name resolution|getaddrinfo|Connection Refused/i },
  connect: { ids: /^cloud\.(not-claimed|claim-state|files|ntp)$/ },
  board: { ids: /^(bus\.|osdp\.|panel\.reader-offline$)/, text: /went offline|NAK|RS-485|expansion|BLU-(RI|IO|O8|XO8|I16)/i },
  reader: { ids: /^bus\.reader-|^osdp\./ },
  config: { ids: /^(sync\.|config\.ioconfig-corrupt$)/ },
  power: { ids: /^(delivery\.(restart|app-starts|log-gap|clock-jump)|cloud\.not-claimed|config\.reset)$/, text: /reboot|restart|power|coredump|start-?up|STARTING|de-?initiali[sz]/i },
  network: { ids: /^(cloud\.network-drop|panel\.ip-change)$/, text: /dns|getaddrinfo|lookup error|name resolution|dhcp|static|NwConfig|network|eth0|ip address/i },
};

// Word synonyms for free text.
const SYN: Record<string, string[]> = {
  offline: ['offline', 'disconnect', 'outage', 'not connected', 'unreachable', 'lost'],
  dns: ['dns', 'getaddrinfo', 'lookup', 'name resolution', 'resolve'],
  power: ['power', 'reboot', 'restart', 'start', 'boot', 'coredump'],
  restart: ['restart', 'reboot', 'start', 'boot'],
  network: ['network', 'dhcp', 'static', 'eth0', 'nwconfig', 'link'],
  mqtt: ['mqtt', 'broker', 'messaging'],
  sync: ['sync', 'synchron'],
  card: ['card', 'credential', 'badge'],
  board: ['board', 'panel', 'blu-', 'expansion'],
};
const STOP = new Set(['the', 'a', 'an', 'is', 'and', 'or', 'of', 'to', 'in', 'on', 'not', 'it', 'its', 'my', 'goes', 'went', 'keeps', 'controller']);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function topics(s: Scan): Topic[] {
  const cat = ((s.report as { symptoms?: Topic[] }).symptoms || []).map(t => ({ ...t, aliases: ALIASES[t.id] || [] }));
  const ids = new Set(cat.map(t => t.id));
  // order: the ones people ask about most first
  const order = ['offline', 'board', 'power', 'network', 'connect', 'reader', 'events', 'config', 'denied', 'unknowncred', 'unlock', 'opens', 'security'];
  return [...cat, ...EXTRA.filter(t => !ids.has(t.id))].sort((a, b) => (order.indexOf(a.id) + 99) % 99 - (order.indexOf(b.id) + 99) % 99);
}

/** A topic when the text names one, else null (free text). */
export function resolveTopic(q: string, list: Topic[]): Topic | null {
  const n = norm(q);
  if (!n) return null;
  return list.find(t => norm(t.label) === n || t.id === n)
    || list.find(t => (t.aliases || []).some(a => a === n))
    || list.find(t => norm(t.label).startsWith(n) && n.length >= 4)
    || null;
}

const hay = (f: Finding) => norm([f.id, f.title, f.detail, (f as { playbook?: { cause?: string } }).playbook?.cause, ...(f.samples || []).map(x => x.text)].filter(Boolean).join(' \n '));
const wordHit = (text: string, w: string) => (SYN[w] || [w]).some(x => text.includes(x));

function inTopic(f: Finding, t: Topic): boolean {
  if (((f as { symptoms?: string[] }).symptoms || []).includes(t.id)) return true;
  const rx = TOPIC_RX[t.id];
  if (!rx) return false;
  if (rx.ids && rx.ids.test(f.id)) return true;
  // power / network words are common in details ('after a restart…'), so for those only the title counts
  return !!rx.text && f.sev !== 'info' && rx.text.test(t.id === 'power' || t.id === 'network' ? f.title : `${f.title} ${f.detail || ''}`);
}

/** Cut the scan down to one problem. */
export function applyCause(s: Scan, q: string): CauseResult {
  const list = topics(s);
  const topic = resolveTopic(q, list);
  const words = topic ? [] : norm(q).split(/[\s,]+/).filter(w => w.length > 1 && !STOP.has(w));
  const all = [...(s.report.findings || []), ...(s.azure.checks || [])];
  const keep = (f: Finding) => (topic ? inTopic(f, topic) : words.length > 0 && words.every(w => wordHit(hay(f), w)));
  const findings = (s.report.findings || []).filter(keep);
  const checks = (s.azure.checks || []).filter(keep);

  // the log lines behind those alerts, oldest first
  const lines: LogLine[] = [];
  const seen = new Set<string>();
  const shownStatus = new Set<number>();   // board offline lines already shown as alert lines
  const push = (l: LogLine) => { const k = `${l.t}|${l.file || ''}|${l.line || ''}|${l.text}`; if (!seen.has(k)) { seen.add(k); lines.push(l); } };
  for (const f of [...findings, ...checks]) for (const x of f.samples || []) {
    if (!topic && words.length && !words.some(w => wordHit(norm(x.text || ''), w)) && !words.every(w => wordHit(norm(`${f.title} ${f.id}`), w))) continue;
    push({ t: x.t ?? null, text: x.text || '', file: x.file, line: x.line, src: f.title, sev: f.sev, kind: 'alert' });
    if (f.id === 'bus.offline-events' && x.t != null) shownStatus.add(x.t);
  }
  const ctxOk = (text: string) => !!topic || words.every(w => wordHit(norm(text), w));
  const tid = topic?.id;
  const a = s.azure;
  // context: Cloud Connector start-ups for controller problems, board/reader status for bus problems
  if (tid === 'offline' || tid === 'connect' || tid === 'power' || tid === 'network' || (!topic && words.some(w => ['offline', 'power', 'restart', 'claim', 'start'].includes(w))))
    for (const l of a.lifecycle || []) if (ctxOk(`${l.state} ${l.msg || ''} start restart power`)) push({ t: l.t, text: [l.kind === 'start' ? 'Cloud Connector STARTING' : l.state, l.fw && `fw ${l.fw}`, l.cc && `CC ${l.cc}`, l.msg].filter(Boolean).join(' · '), src: 'Cloud Connector start-up', kind: 'startup' });
  if (tid === 'board' || tid === 'reader' || (!topic && words.some(w => ['offline', 'board', 'reader', 'nak', 'panel'].includes(w))))
    for (const d of a.deviceStatus || []) {
      if (tid === 'reader' && d.kind !== 'reader') continue;
      const b = d.kind === 'board' ? a.boards.find(x => x.lda === d.lda) : null;
      const text = `${b ? b.model : d.kind} ${d.node}-${d.lda}-${d.idx} [${d.reason}] ${d.state}`;
      if (shownStatus.has(d.t) || !ctxOk(`${text} board panel`)) continue;
      push({ t: d.t, text: `${b ? b.model : d.kind} ${d.node}-${d.lda}-${d.idx} [${d.reason}] ${d.state}`, src: 'Board / reader status', sev: d.state === 'offline' ? 'medium' : 'info', kind: 'status' });
    }
  lines.sort((x, y) => (x.t ?? Infinity) - (y.t ?? Infinity));

  const hops = rehop(a.hops || [], findings, checks);
  return {
    topic, words, lines, matched: findings.length + checks.length, total: all.length,
    scan: { ...s, report: { ...s.report, findings }, azure: { ...a, checks, hops } },
  };
}
