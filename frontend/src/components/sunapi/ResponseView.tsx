// AETHER_SUNAPI — response viewer: Table · JSON · Raw · Headers
import React, { useMemo, useState } from 'react';
import { Copy, Download, ChevronRight, ChevronDown, Search, AlertTriangle, Check } from 'lucide-react';
import { parseBody, flatten } from './catalog';
import { Badge, Tabs, IconButton, Input, copyText, download, fmtBytes, statusTone, cx } from './ui';

export interface ShownResponse {
  status: number; statusText?: string; ms?: number; bytes?: number; contentType?: string; truncated?: boolean; clipped?: boolean;
  body: string; bodyEncoding?: 'utf8' | 'base64'; headers?: Record<string, string>; auth?: string; url?: string; error?: string;
  label?: string;                      // "image.cgi › privacy · view"
}

type View = 'table' | 'json' | 'raw' | 'headers';

export const ResponseView: React.FC<{ r: ShownResponse; fileBase?: string; actions?: React.ReactNode }> = ({ r, fileBase = 'sunapi-response', actions }) => {
  const parsed = useMemo(() => (r.bodyEncoding === 'base64' ? null : parseBody(r.body || '')), [r.body, r.bodyEncoding]);
  const isImage = r.bodyEncoding === 'base64' && /^image\//.test(r.contentType || '');
  const [view, setView] = useState<View>('table');
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);
  const fail = parsed?.kind === 'json' && parsed.data && typeof parsed.data === 'object' && (parsed.data as Record<string, unknown>).Response === 'Fail'
    ? (parsed.data as { Error?: { Code?: number; Details?: string } }).Error || {} : null;

  const pretty = parsed?.kind === 'json' ? JSON.stringify(parsed.data, null, 2) : r.body;
  const doCopy = () => { copyText(view === 'headers' ? JSON.stringify(r.headers, null, 2) : pretty).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); };
  const doDownload = () => {
    if (isImage) { const a = document.createElement('a'); a.href = `data:${r.contentType};base64,${r.body}`; a.download = `${fileBase}.${(r.contentType || 'image/jpeg').split('/')[1].split(';')[0]}`; a.click(); return; }
    download(`${fileBase}.${parsed?.kind === 'json' ? 'json' : 'txt'}`, pretty, parsed?.kind === 'json' ? 'application/json' : 'text/plain');
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* status line */}
      <div className="flex items-center gap-2 flex-wrap px-4 py-2.5 border-b border-hv-line">
        <Badge tone={statusTone(r.status)}>{r.status === 0 ? 'No answer' : `${r.status} ${r.statusText || ''}`.trim()}</Badge>
        {r.ms !== undefined && <span className="text-xs text-hv-text-3 font-mono">{r.ms} ms</span>}
        {r.bytes !== undefined && <span className="text-xs text-hv-text-3 font-mono">{fmtBytes(r.bytes)}</span>}
        {r.contentType && <span className="text-xs text-hv-text-3 truncate max-w-[180px]" title={r.contentType}>{r.contentType.split(';')[0]}</span>}
        {r.auth && r.auth !== 'none' && <span className="text-xs text-hv-text-3" title="How the Pi authenticated">· {r.auth}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {actions}
          <IconButton label={copied ? 'Copied' : 'Copy'} onClick={doCopy}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconButton>
          <IconButton label="Download" onClick={doDownload}><Download size={15} /></IconButton>
        </div>
      </div>

      {r.error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-hv-xs bg-hv-error-tint ring-1 ring-inset ring-hv-error/40 px-3 py-2 text-sm text-hv-error-fg">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{r.error}</span>
        </div>
      )}
      {fail && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-hv-xs bg-hv-warning-tint ring-1 ring-inset ring-hv-warning/40 px-3 py-2 text-sm text-hv-text">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-hv-warning-fg" />
          <span>The device refused this request{fail.Code !== undefined && <> — error <b className="font-mono">{fail.Code}</b></>}{fail.Details && <>: {fail.Details}</>}</span>
        </div>
      )}
      {(r.truncated || r.clipped) && (
        <div className="mx-4 mt-3 text-xs text-hv-warning-fg">{r.clipped ? 'History keeps the first 64 KB of each answer — send it again to see all of it.' : 'Answer was larger than 4 MB and was cut off.'}</div>
      )}

      {isImage ? (
        <div className="flex-1 min-h-0 overflow-auto p-4 flex items-start justify-center">
          <img src={`data:${r.contentType};base64,${r.body}`} alt="Image from the device" className="max-w-full rounded-hv-xs ring-1 ring-hv-line" />
        </div>
      ) : r.status !== 0 || r.body ? (
        <>
          <div className="flex items-center gap-3 px-4 pt-1">
            <Tabs size="sm" value={view} onChange={setView} className="flex-1"
              items={[{ id: 'table', label: 'Table' }, { id: 'json', label: 'JSON', disabled: parsed?.kind !== 'json' }, { id: 'raw', label: 'Raw' }, { id: 'headers', label: 'Headers', disabled: !r.headers }]} />
            {(view === 'table' || view === 'json') && (
              <div className="relative w-48 shrink-0">
                <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-hv-text-3" />
                <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter fields" className="h-7 pl-7 text-xs" />
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
            {view === 'table' && parsed && <SmartTable parsed={parsed} filter={filter} />}
            {view === 'json' && parsed?.kind === 'json' && <JsonTree data={parsed.data} filter={filter} />}
            {view === 'raw' && <pre className="font-mono text-[12.5px] leading-relaxed text-hv-text whitespace-pre-wrap break-all">{pretty || <span className="text-hv-text-3">(empty body)</span>}</pre>}
            {view === 'headers' && r.headers && (
              <div className="space-y-3">
                {r.url && <div><div className="text-[11px] font-semibold text-hv-text-3 mb-1">Request URL (from the Pi)</div><div className="font-mono text-[12.5px] text-hv-text break-all">{r.url}</div></div>}
                <KVTable rows={Object.entries(r.headers).map(([k, v]) => [k, String(v)])} />
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------- tables
const match = (f: string, ...s: string[]) => !f || s.some(x => x.toLowerCase().includes(f.toLowerCase()));

export const KVTable: React.FC<{ rows: [string, string][]; filter?: string }> = ({ rows, filter = '' }) => {
  const shown = rows.filter(([k, v]) => match(filter, k, v));
  if (!shown.length) return <div className="text-xs text-hv-text-3 py-2">No fields match.</div>;
  return (
    <table className="w-full text-[13px] border-separate border-spacing-0">
      <tbody>
        {shown.map(([k, v]) => (
          <tr key={k} className="group">
            <td className="py-1.5 pr-4 align-top text-hv-text-3 font-mono text-[12px] whitespace-nowrap border-b border-hv-line/60">{k}</td>
            <td className="py-1.5 align-top text-hv-text break-all border-b border-hv-line/60"><Val v={v} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const Val: React.FC<{ v: string }> = ({ v }) =>
  v === 'True' || v === 'true' ? <span className="text-hv-success-fg font-semibold">{v}</span>
    : v === 'False' || v === 'false' ? <span className="text-hv-text-3 font-semibold">{v}</span>
      : v === '' ? <span className="text-hv-text-disabled">empty</span>
        : <>{v}</>;

const SmartTable: React.FC<{ parsed: NonNullable<ReturnType<typeof parseBody>>; filter: string }> = ({ parsed, filter }) => {
  if (parsed.kind === 'kv') return <KVTable rows={Object.entries(parsed.data)} filter={filter} />;
  if (parsed.kind === 'text') return <pre className="font-mono text-[12.5px] text-hv-text whitespace-pre-wrap break-all">{parsed.data || <span className="text-hv-text-3">(empty body)</span>}</pre>;
  const d = parsed.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return <KVTable rows={Object.entries(flatten(d))} filter={filter} />;
  const scalars: [string, string][] = [];
  const blocks: React.ReactNode[] = [];
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length && v.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      blocks.push(<RecordTable key={k} title={k} rows={v as Record<string, unknown>[]} filter={filter} />);
    } else if (v && typeof v === 'object') {
      for (const [fk, fv] of Object.entries(flatten(v, k))) scalars.push([fk, fv]);
    } else scalars.push([k, v === null ? 'null' : String(v)]);
  }
  return (
    <div className="space-y-5">
      {scalars.length > 0 && <KVTable rows={scalars} filter={filter} />}
      {blocks}
    </div>
  );
};

/** An array of records (usually one per channel / profile / rule) as a real table. */
const RecordTable: React.FC<{ title: string; rows: Record<string, unknown>[]; filter: string }> = ({ title, rows, filter }) => {
  const flat = useMemo(() => rows.map(r => flatten(r)), [rows]);
  const cols = useMemo(() => { const s: string[] = []; for (const r of flat) for (const k of Object.keys(r)) if (!s.includes(k)) s.push(k); return s; }, [flat]);
  const shownCols = cols.filter(c => match(filter, c) || flat.some(r => match(filter, r[c] ?? '')));
  // Many columns and few rows read better transposed (field per row, record per column).
  const transpose = shownCols.length > 8 && rows.length <= 6;
  const lead = cols.find(c => /^(Channel|Profile|ProfileName|Name|Index|RuleIndex|PresetIndex|UserID|Id)$/i.test(c));
  return (
    <section>
      <div className="flex items-center gap-2 mb-1.5">
        <h4 className="text-xs font-bold text-hv-text">{title}</h4>
        <span className="text-[11px] text-hv-text-3">{rows.length} {rows.length === 1 ? 'record' : 'records'} · {cols.length} fields</span>
      </div>
      {!shownCols.length ? <div className="text-xs text-hv-text-3">No fields match.</div> : (
        <div className="overflow-auto rounded-hv-xs ring-1 ring-inset ring-hv-line">
          {transpose ? (
            <table className="text-[12.5px] border-separate border-spacing-0 min-w-full">
              <thead><tr className="bg-hv-widget">
                <th className="sticky left-0 bg-hv-widget text-left font-semibold text-hv-text-3 px-3 py-1.5 border-b border-hv-line">Field</th>
                {flat.map((r, i) => <th key={i} className="text-left font-semibold text-hv-text-2 px-3 py-1.5 border-b border-hv-line whitespace-nowrap">{lead ? `${lead} ${r[lead]}` : `#${i}`}</th>)}
              </tr></thead>
              <tbody>{shownCols.map(c => {
                const differs = new Set(flat.map(r => r[c] ?? '')).size > 1;
                return (
                  <tr key={c}>
                    <td className="sticky left-0 bg-hv-widget-panel font-mono text-[12px] text-hv-text-3 px-3 py-1 border-b border-hv-line/60 whitespace-nowrap">{c}</td>
                    {flat.map((r, i) => <td key={i} className={cx('px-3 py-1 border-b border-hv-line/60 whitespace-nowrap', differs ? 'text-hv-text' : 'text-hv-text-2')}><Val v={r[c] ?? ''} /></td>)}
                  </tr>
                );
              })}</tbody>
            </table>
          ) : (
            <table className="text-[12.5px] border-separate border-spacing-0 min-w-full">
              <thead><tr className="bg-hv-widget">{shownCols.map(c => <th key={c} className="text-left font-semibold text-hv-text-3 px-3 py-1.5 border-b border-hv-line whitespace-nowrap font-mono text-[11.5px]">{c}</th>)}</tr></thead>
              <tbody>{flat.map((r, i) => <tr key={i} className="hover:bg-hv-widget/60">{shownCols.map(c => <td key={c} className="px-3 py-1 border-b border-hv-line/60 whitespace-nowrap text-hv-text"><Val v={r[c] ?? ''} /></td>)}</tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
};

// ---------------------------------------------------------------- JSON tree
const has = (v: unknown, f: string): boolean => {
  if (!f) return true;
  if (v === null || typeof v !== 'object') return String(v).toLowerCase().includes(f);
  return Object.entries(v as Record<string, unknown>).some(([k, x]) => k.toLowerCase().includes(f) || has(x, f));
};

export const JsonTree: React.FC<{ data: unknown; filter?: string }> = ({ data, filter = '' }) => (
  <div className="font-mono text-[12.5px] leading-[1.7]"><Node k={null} v={data} depth={0} f={filter.toLowerCase()} /></div>
);

const Node: React.FC<{ k: string | null; v: unknown; depth: number; f: string }> = ({ k, v, depth, f }) => {
  const [open, setOpen] = useState(depth < 3);
  const isObj = v !== null && typeof v === 'object';
  if (f && k !== null && !k.toLowerCase().includes(f) && !has(v, f)) return null;
  const key = k !== null && <span className="text-hv-info-fg">{k}</span>;
  if (!isObj) {
    const color = typeof v === 'string' ? 'text-hv-success-fg' : typeof v === 'number' ? 'text-hv-brand-fg' : 'text-hv-purple-fg';
    return <div style={{ paddingLeft: depth * 14 }}>{key}{key && <span className="text-hv-text-3">: </span>}<span className={color}>{typeof v === 'string' ? `"${v}"` : String(v)}</span></div>;
  }
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as [string, unknown]) : Object.entries(v as Record<string, unknown>);
  const shut = Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}`;
  const forced = !!f;
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} className="inline-flex items-center hover:bg-hv-widget rounded-[3px] pr-1" style={{ marginLeft: depth * 14 - 14 < 0 ? 0 : depth * 14 - 14 }}>
        {(open || forced) ? <ChevronDown size={13} className="text-hv-text-3" /> : <ChevronRight size={13} className="text-hv-text-3" />}
        {key}{key && <span className="text-hv-text-3">: </span>}<span className="text-hv-text-3">{shut}</span>
      </button>
      {(open || forced) && entries.map(([ck, cv]) => <Node key={ck} k={ck} v={cv} depth={depth + 1} f={f} />)}
    </div>
  );
};
