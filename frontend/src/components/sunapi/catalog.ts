// SUNAPI catalog: parses a device's attributes.cgi XML into a tree the console can browse.
// AETHER_SUNAPI

export type ParamType = 'int' | 'float' | 'enum' | 'string' | 'bool' | 'csv' | 'unknown';

export interface Param {
  name: string;
  request: boolean;
  response: boolean;
  type: ParamType;
  min?: number;
  max?: number;
  maxlen?: number;
  minlen?: number;
  values?: string[];          // enum / csv entries
  trueValue?: string;
  falseValue?: string;
  format?: string;
  templated: boolean;         // name holds <Placeholder> or #
}

export interface Action { name: string; access: string; params: Param[] }
export interface Submenu { cgi: string; name: string; actions: Action[] }
export interface Cgi { name: string; submenus: Submenu[] }
export interface Capability { group: string; category: string; name: string; type: string; value: string; access: string }
export interface Catalog { cgis: Cgi[]; capabilities: Capability[]; model?: string; firmware?: string; sunapiVersion?: string; maxChannel: number; submenuCount: number; actionCount: number }

const local = (el: Element) => el.localName || el.nodeName.replace(/^.*:/, '');
const kids = (el: Element, name?: string) => Array.from(el.children).filter(c => !name || local(c) === name);
const num = (v: string | null) => (v == null || v === '' || isNaN(Number(v)) ? undefined : Number(v));

function parseParam(p: Element): Param {
  const name = p.getAttribute('name') || '';
  const out: Param = {
    name,
    request: p.getAttribute('request') === 'true',
    response: p.getAttribute('response') === 'true',
    type: 'unknown',
    templated: /[<#]/.test(name),
  };
  const dt = kids(p, 'dataType')[0];
  const t = dt && dt.children[0];
  if (!t) return out;
  const tag = local(t);
  if (tag === 'int' || tag === 'float') {
    out.type = tag; out.min = num(t.getAttribute('min')); out.max = num(t.getAttribute('max'));
  } else if (tag === 'bool') {
    out.type = 'bool'; out.trueValue = t.getAttribute('true') || 'True'; out.falseValue = t.getAttribute('false') || 'False';
  } else if (tag === 'enum' || tag === 'csv') {
    out.type = tag; out.values = kids(t, 'entry').map(e => e.getAttribute('value') || '');
  } else if (tag === 'string') {
    out.type = 'string'; out.maxlen = num(t.getAttribute('maxlen')); out.minlen = num(t.getAttribute('minlen'));
    out.format = t.getAttribute('format') || undefined;
  }
  return out;
}

/** Copies saved from a browser's XML viewer carry a banner line and un-escaped <, > or & inside
 *  attribute values (format="PT<N>M"). Strip the banner and re-escape so they still parse. */
export function repairXml(xml: string): string {
  const start = xml.search(/<\?xml|<capabilities/);
  const s = start > 0 ? xml.slice(start) : xml;
  return s.replace(/="([^"]*)"/g, (_m, v: string) => `="${v.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`);
}

function parseXml(xml: string): Document {
  const p = new DOMParser();
  let doc = p.parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror')[0]) doc = p.parseFromString(repairXml(xml), 'application/xml');
  if (doc.getElementsByTagName('parsererror')[0]) throw new Error('Not a valid attributes.xml (XML parse error)');
  return doc;
}

export function parseAttributes(xml: string): Catalog {
  const doc = parseXml(xml);
  const all = Array.from(doc.getElementsByTagName('*'));
  const cgisEl = all.find(e => local(e) === 'cgis');
  if (!cgisEl) throw new Error('No <cgis> section — is this a SUNAPI attributes file?');

  const cgis: Cgi[] = kids(cgisEl, 'cgi').map(c => {
    const cgi = c.getAttribute('name') || '';
    return {
      name: cgi,
      submenus: kids(c, 'submenu').map(s => ({
        cgi,
        name: s.getAttribute('name') || '',
        actions: expandActions(kids(s, 'action').map(a => ({
          name: a.getAttribute('name') || '',
          access: a.getAttribute('accesslevel') || '',
          params: kids(a, 'parameter').map(parseParam),
        }))),
      })),
    };
  });

  const capabilities: Capability[] = [];
  const attrsEl = all.find(e => local(e) === 'attributes');
  if (attrsEl) for (const g of kids(attrsEl, 'group')) for (const cat of kids(g, 'category')) {
    const push = (a: Element, prefix = '') => capabilities.push({ group: g.getAttribute('name') || '', category: cat.getAttribute('name') || '', name: prefix + (a.getAttribute('name') || ''), type: a.getAttribute('type') || '', value: a.getAttribute('value') || '', access: a.getAttribute('accesslevel') || '' });
    for (const a of kids(cat, 'attribute')) push(a);
    // per-channel overrides: <channel number="1"><attribute …/></channel>
    for (const ch of kids(cat, 'channel')) for (const a of kids(ch, 'attribute')) push(a, `Channel ${ch.getAttribute('number')} · `);
  }
  const cap = (n: string) => capabilities.find(c => c.group === 'System' && c.name === n)?.value;
  const submenuCount = cgis.reduce((n, c) => n + c.submenus.length, 0);
  const actionCount = cgis.reduce((n, c) => n + c.submenus.reduce((m, s) => m + s.actions.length, 0), 0);
  return { cgis, capabilities, model: cap('ModelName'), firmware: cap('FirmwareVersion'), sunapiVersion: cap('SUNAPIVersion'), maxChannel: Number(cap('MaxChannel') || 1) || 1, submenuCount, actionCount };
}

/** attributes.cgi names an action "add/update" when add and update share parameters; the
 *  request itself must say action=add or action=update, so offer them as separate actions. */
function expandActions(list: Action[]): Action[] {
  const out: Action[] = [];
  for (const a of list) {
    if (!a.name.includes('/')) { out.push(a); continue; }
    for (const part of a.name.split('/').map(x => x.trim()).filter(Boolean)) {
      if (!list.some(x => x.name === part) && !out.some(x => x.name === part)) out.push({ ...a, name: part });
    }
  }
  return out;
}

// ---------------------------------------------------------------- safety
export type Risk = 'read' | 'change' | 'danger';
const DANGER_SUBMENUS = new Set(['factoryreset', 'power', 'firmwareupdate', 'configrestore', 'certificate', 'cacertificate', 'interface', 'http', 'https', 'users', 'ipfilter', '802dot1x', 'rsa', 'ssl', 'tlsversion', 'storage']);
const READ_ACTIONS = new Set(['view', 'check', 'monitor', 'monitordiff']);
export function riskOf(sub: string, action: string): Risk {
  if (READ_ACTIONS.has(action.toLowerCase())) return 'read';
  if (DANGER_SUBMENUS.has(sub.toLowerCase())) return 'danger';
  if (action === 'remove' || action === 'install') return 'danger';
  return 'change';
}
/** Changes that move real hardware — shown before sending. */
export const HARDWARE_NOTE: Record<string, string> = {
  door: 'Door control locks, unlocks or locks down a real door on this controller.',
  alarmoutput: 'Drives a real relay / alarm output.',
  credentialreader: 'Acts on a real reader attached to this controller.',
  hostcommunication: 'Changes how this controller talks to its host (e.g. OnCAFE). It can go offline to the host.',
  ptzcontrol: 'Moves the camera.',
};
export const DANGER_NOTE: Record<string, string> = {
  factoryreset: 'Factory reset wipes the device configuration.',
  power: 'This can reboot the device; it drops off the network for a minute or two.',
  firmwareupdate: 'Firmware update can leave the device unusable if interrupted.',
  configrestore: 'Restoring a configuration overwrites the current settings.',
  interface: 'Changing the network interface can make the device unreachable from the Pi.',
  http: 'Changing the HTTP port can make the device unreachable from Aether.',
  https: 'Changing HTTPS settings can make the device unreachable from Aether.',
  users: 'Changing users can lock Aether (or you) out of the device.',
  ipfilter: 'An IP filter can block the Pi from reaching the device.',
};

// ---------------------------------------------------------------- request URL
export function buildQuery(sub: Submenu, action: string, values: Record<string, string>, extra: [string, string][] = []): string {
  const parts = [`msubmenu=${encodeURIComponent(sub.name)}`, `action=${encodeURIComponent(action)}`];
  for (const [k, v] of Object.entries(values)) parts.push(`${encodeKey(k)}=${encodeVal(v)}`);
  for (const [k, v] of extra) if (k.trim()) parts.push(`${encodeKey(k.trim())}=${encodeVal(v)}`);
  return parts.join('&');
}
// SUNAPI accepts ',' ':' '.' unescaped in values; keeping them readable makes the URL easy to compare with docs.
const encodeVal = (v: string) => encodeURIComponent(v).replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%2F/gi, '/');
const encodeKey = (k: string) => encodeURIComponent(k).replace(/%2E/gi, '.');

export function validate(p: Param, v: string): string | null {
  if (v === '') return null;
  if (p.type === 'int' || p.type === 'float') {
    const n = Number(v);
    if (!isFinite(n) || (p.type === 'int' && !/^-?\d+$/.test(v.trim()))) return p.type === 'int' ? 'Whole number' : 'Number';
    if (p.min !== undefined && n < p.min) return `Min ${p.min}`;
    if (p.max !== undefined && n > p.max) return `Max ${p.max}`;
  }
  if (p.type === 'string') {
    if (p.maxlen !== undefined && v.length > p.maxlen) return `Max ${p.maxlen} chars`;
    if (p.minlen !== undefined && v.length < p.minlen) return `Min ${p.minlen} chars`;
  }
  if (p.type === 'enum' && p.values?.length && !p.values.includes(v)) return 'Not in list';
  return null;
}

export function typeHint(p: Param): string {
  switch (p.type) {
    case 'int': case 'float': return p.min !== undefined || p.max !== undefined ? `${p.type} ${p.min ?? '…'}–${p.max ?? '…'}` : p.type;
    case 'enum': return `enum · ${p.values?.length ?? 0}`;
    case 'csv': return p.values?.length ? `list · ${p.values.length}` : 'list';
    case 'bool': return 'bool';
    case 'string': return p.format ? p.format : p.maxlen !== undefined ? `text ≤${p.maxlen}` : 'text';
    default: return '';
  }
}

// ---------------------------------------------------------------- responses
/** Parses a SUNAPI body: JSON when it is JSON, else the classic Key=Value text. */
export function parseBody(body: string): { kind: 'json'; data: unknown } | { kind: 'kv'; data: Record<string, string> } | { kind: 'text'; data: string } {
  const t = body.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return { kind: 'json', data: JSON.parse(t) }; } catch { /* */ } }
  const lines = t.split(/\r?\n/).filter(Boolean);
  if (lines.length && lines.every(l => /^[^=\s][^=]*=/.test(l))) {
    const data: Record<string, string> = {};
    for (const l of lines) { const i = l.indexOf('='); data[l.slice(0, i)] = l.slice(i + 1); }
    return { kind: 'kv', data };
  }
  return { kind: 'text', data: body };
}

/** Flattens any JSON into "a.b[0].c" → value pairs (used by tables, diff and CSV). */
export function flatten(v: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (v === null || typeof v !== 'object') { out[prefix || '(value)'] = v === null ? 'null' : String(v); return out; }
  if (Array.isArray(v)) {
    if (!v.length) out[prefix] = '[]';
    v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out));
    return out;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) out[prefix] = '{}';
  for (const [k, x] of entries) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

export function flatBody(body: string): Record<string, string> {
  const p = parseBody(body);
  if (p.kind === 'json') return flatten(p.data);
  if (p.kind === 'kv') return p.data;
  return { '(text)': p.data };
}

/** Values from a view response that match a set action's parameters (first record / chosen channel). */
export function prefillFrom(body: string, params: Param[], channel?: string): Record<string, string> {
  const p = parseBody(body);
  const out: Record<string, string> = {};
  const want = new Map(params.filter(x => x.request && !x.templated).map(x => [x.name.toLowerCase(), x.name]));
  const byName = new Map(params.map(x => [x.name, x]));
  // Devices answer JSON booleans (true) while set expects the declared spelling (True).
  const norm = (name: string, v: string) => {
    const p = byName.get(name);
    if (p?.type === 'bool') return /^(true|1)$/i.test(v) ? (p.trueValue || 'True') : /^(false|0)$/i.test(v) ? (p.falseValue || 'False') : v;
    if (p?.type === 'enum' && p.values) return p.values.find(x => x.toLowerCase() === v.toLowerCase()) ?? v;
    return v;
  };
  const take = (obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      const name = want.get(k.toLowerCase());
      if (name && (typeof v !== 'object' || v === null)) out[name] = norm(name, String(v));
      else if (name && Array.isArray(v) && v.every(x => typeof x !== 'object')) out[name] = v.join(',');
    }
  };
  if (p.kind === 'kv') {
    for (const [k, v] of Object.entries(p.data)) {
      const m = /^Channel\.(\d+)\.(.+)$/.exec(k);
      if (m && channel !== undefined && m[1] !== channel) continue;
      const name = want.get((m ? m[2] : k).toLowerCase());
      if (name && !(name in out)) out[name] = norm(name, v);
    }
    return out;
  }
  if (p.kind !== 'json' || !p.data || typeof p.data !== 'object') return out;
  const root = p.data as Record<string, unknown>;
  take(root);
  for (const v of Object.values(root)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      const rec = (channel !== undefined && v.find(r => r && String((r as Record<string, unknown>).Channel) === channel)) || v[0];
      take(rec as Record<string, unknown>);
    }
  }
  return out;
}
