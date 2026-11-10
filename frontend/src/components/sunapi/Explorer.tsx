// AETHER_SUNAPI — Explorer: catalog tree · request builder · response
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Star, ChevronRight, ChevronDown, Send, Link2, Terminal, RotateCcw, ShieldAlert, Info, CheckCircle2, XCircle, Plus, Trash2, FileText, Wand2, Eye } from 'lucide-react';
import type { Catalog, Submenu, Param, Action } from './catalog';
import { buildQuery, validate, typeHint, riskOf, DANGER_NOTE, HARDWARE_NOTE, prefillFrom, parseBody, flatBody } from './catalog';
import type { Client, Device, SunapiResult } from './api';
import { ResponseView, type ShownResponse } from './ResponseView';
import { FleetResults, type FleetRun } from './Fleet';
import { KindIcon } from './kinds';
import { Badge, Button, Dialog, Empty, IconButton, Input, Segmented, Select, actionTone, copyText, cx, lsGet, lsSet } from './ui';

export interface Target { cgi: string; sub: string; action?: string; query?: string }

interface Props {
  catalog: Catalog | null;
  device: Device | null;
  fleet: Device[];                   // every device a request goes to (primary first)
  online: boolean;
  api: Client;
  jump: Target | null;               // set by History "Open in Explorer"
  onSent: () => void;                // refresh history counts
}

const key = (s: Submenu, a: string) => `${s.cgi}/${s.name}/${a}`;
// Fields that pick WHICH record a set applies to — always sent, even when unchanged.
const IDENTITY = /^(Channel|Profile|ProfileNumber|ProfileName|Index|.*Index|UserID|AppID|Id|Preset)$/i;
const FAV_KEY = 'aether.sunapi.favorites';

export const Explorer: React.FC<Props> = ({ catalog, device, fleet, online, api, jump, onSent }) => {
  const multi = fleet.length > 1;
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>(() => lsGet('aether.sunapi.open', {}));
  const [favs, setFavs] = useState<string[]>(() => lsGet(FAV_KEY, []));
  const [sel, setSel] = useState<{ cgi: string; sub: string } | null>(() => lsGet('aether.sunapi.sel', null));
  const [actionName, setActionName] = useState<string>('view');
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [keys, setKeys] = useState<Record<string, Record<string, string>>>({});       // templated name overrides
  const [extra, setExtra] = useState<Record<string, [string, string][]>>({});
  const [baselines, setBaselines] = useState<Record<string, Record<string, string>>>({});   // device's current values per form
  const [accept, setAccept] = useState<'json' | 'text'>(() => lsGet('aether.sunapi.accept', 'json'));
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<ShownResponse | null>(null);
  const [fleetRun, setFleetRun] = useState<FleetRun | null>(null);
  const [sendAll, setSendAll] = useState(false);          // multi: also send fields equal to the primary's
  const pendingAction = useRef<string | null>(null);
  const [lastView, setLastView] = useState<Record<string, string>>({});                 // "cgi/sub" -> body
  const [confirm, setConfirm] = useState<null | { query: string }>(null);
  const [understood, setUnderstood] = useState(false);
  const [skipConfirm, setSkipConfirm] = useState(false);
  const [verify, setVerify] = useState<null | { ok: number; total: number; mismatched: [string, string, string][] }>(null);
  const [showReturns, setShowReturns] = useState(false);
  const [prefillNote, setPrefillNote] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => lsSet('aether.sunapi.open', open), [open]);
  useEffect(() => lsSet(FAV_KEY, favs), [favs]);
  useEffect(() => lsSet('aether.sunapi.sel', sel), [sel]);
  useEffect(() => lsSet('aether.sunapi.accept', accept), [accept]);

  const submenu = useMemo(() => {
    if (!catalog || !sel) return null;
    return catalog.cgis.find(c => c.name === sel.cgi)?.submenus.find(s => s.name === sel.sub) || null;
  }, [catalog, sel]);
  const action: Action | null = submenu?.actions.find(a => a.name === actionName) || submenu?.actions[0] || null;
  const k = submenu && action ? key(submenu, action.name) : '';
  const vals = values[k] || {};
  const names = keys[k] || {};
  const extras = extra[k] || [];
  const base = baselines[k] || {};
  const isSame = (n: string, v: string) => !(multi && sendAll) && base[n] !== undefined && base[n] === v && !IDENTITY.test(n);
  const reqParams = useMemo(() => action?.params.filter(p => p.request) || [], [action]);
  // A view usually declares only its inputs; the fields it returns are declared on set/add.
  const resParams = useMemo(() => {
    if (!action || !submenu) return [];
    const pool = action.name === 'view' ? submenu.actions.flatMap(a => a.params) : action.params;
    const seen = new Set<string>();
    return pool.filter(p => p.response && !(action.params.includes(p) && p.request) && !seen.has(p.name) && !!seen.add(p.name));
  }, [action, submenu]);

  // keep a valid action when the submenu changes
  useEffect(() => {
    if (!submenu) return;
    const want = pendingAction.current; pendingAction.current = null;
    // a newly picked menu opens on its read-only action; History can ask for another
    setActionName(want && submenu.actions.some(a => a.name === want) ? want : submenu.actions.find(a => a.name === 'view')?.name || submenu.actions[0]?.name || 'view');
    setVerify(null); setPrefillNote(null);
  }, [submenu]); // eslint-disable-line react-hooks/exhaustive-deps

  // History → Explorer
  useEffect(() => {
    if (!jump || !catalog) return;
    setSel({ cgi: jump.cgi, sub: jump.sub });
    setOpen(o => ({ ...o, [jump.cgi]: true }));
    if (jump.action) { pendingAction.current = jump.action; setActionName(jump.action); }
    if (jump.query && jump.action) {
      const sm = catalog.cgis.find(c => c.name === jump.cgi)?.submenus.find(s => s.name === jump.sub);
      const act = sm?.actions.find(a => a.name === jump.action);
      if (sm && act) {
        const known = new Set(act.params.filter(p => p.request).map(p => p.name.toLowerCase()));
        const v: Record<string, string> = {}; const ex: [string, string][] = [];
        for (const part of jump.query.split('&')) {
          const i = part.indexOf('='); if (i < 0) continue;
          const pk = decodeURIComponent(part.slice(0, i)); const pv = decodeURIComponent(part.slice(i + 1));
          if (/^(msubmenu|action)$/i.test(pk)) continue;
          const p = act.params.find(x => x.name.toLowerCase() === pk.toLowerCase());
          if (p && known.has(pk.toLowerCase())) v[p.name] = pv; else ex.push([pk, pv]);
        }
        const kk = key(sm, act.name);
        setValues(o => ({ ...o, [kk]: v })); setExtra(o => ({ ...o, [kk]: ex }));
      }
    }
  }, [jump, catalog]);

  // ------------------------------------------------------------ catalog filter
  const term = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!catalog) return [];
    return catalog.cgis.map(c => {
      // score: exact menu name 0 · starts with 1 · contains 2 · cgi name 3 · field name 4
      const subs = c.submenus.map(s => {
        if (!term) return { s, why: '', score: 0 };
        const n = s.name.toLowerCase();
        if (n === term) return { s, why: '', score: 0 };
        if (n.startsWith(term)) return { s, why: '', score: 1 };
        if (n.includes(term)) return { s, why: '', score: 2 };
        if (c.name.includes(term)) return { s, why: '', score: 3 };
        const p = s.actions.flatMap(a => a.params).find(p => p.name.toLowerCase().includes(term));
        return p ? { s, why: p.name, score: 4 } : null;
      }).filter(Boolean) as { s: Submenu; why: string; score: number }[];
      if (term) subs.sort((a, b) => a.score - b.score);
      return { c, subs, best: subs.length ? subs[0].score : 9 };
    }).filter(x => x.subs.length).sort((a, b) => (term ? a.best - b.best : 0));
  }, [catalog, term]);
  const favSubs = useMemo(() => (catalog ? favs.map(f => { const [c, s] = f.split('/'); return catalog.cgis.find(x => x.name === c)?.submenus.find(x => x.name === s); }).filter(Boolean) as Submenu[] : []), [catalog, favs]);

  // ------------------------------------------------------------ values
  const setVal = (name: string, v: string) => setValues(o => ({ ...o, [k]: { ...(o[k] || {}), [name]: v } }));
  const setKey = (name: string, v: string) => setKeys(o => ({ ...o, [k]: { ...(o[k] || {}), [name]: v } }));
  const sendable = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of reqParams) { const v = vals[p.name]; if (v !== undefined && v !== '' && !isSame(p.name, v)) out[p.templated ? (names[p.name] || p.name) : p.name] = v; }
    return out;
  }, [reqParams, vals, names, base, multi, sendAll]); // eslint-disable-line react-hooks/exhaustive-deps
  const nothingChanged = Object.keys(base).length > 0 && !Object.keys(sendable).some(n => !IDENTITY.test(n)) && !extras.some(e => e[0]);
  const errors = useMemo(() => Object.fromEntries(reqParams.map(p => [p.name, validate(p, vals[p.name] ?? '')]).filter(([, e]) => e)), [reqParams, vals]);
  const templatedUnfilled = reqParams.filter(p => p.templated && vals[p.name] && (!names[p.name] || /[<#]/.test(names[p.name])));
  const query = submenu && action ? buildQuery(submenu, action.name, sendable, extras) : '';
  const root = device?.cgiRoot || 'stw-cgi';
  const path = submenu ? `/${root}/${submenu.cgi}.cgi` : '';
  const risk = submenu && action ? riskOf(submenu.name, action.name) : 'read';
  const fullUrl = device ? `${device.https ? 'https' : 'http'}://${device.host}${device.port && device.port !== (device.https ? 443 : 80) ? ':' + device.port : ''}${path}?${query}` : `${path}?${query}`;
  const lastViewBody = submenu ? lastView[`${submenu.cgi}/${submenu.name}`] : undefined;

  const prefill = () => {
    if (!lastViewBody || !action) return;
    const pf = prefillFrom(lastViewBody, action.params, vals.Channel);
    setValues(o => ({ ...o, [k]: { ...(o[k] || {}), ...pf } }));
    setBaselines(o => ({ ...o, [k]: pf }));
    setPrefillNote(`Loaded ${Object.keys(pf).length} current value${Object.keys(pf).length === 1 ? '' : 's'}. Only the fields you change are sent.`);
  };
  const clearAll = () => { setValues(o => ({ ...o, [k]: {} })); setExtra(o => ({ ...o, [k]: [] })); setBaselines(o => ({ ...o, [k]: {} })); setPrefillNote(null); };

  // ------------------------------------------------------------ send
  const doSend = useCallback(async (confirmed: boolean) => {
    if (!device || !submenu || !action) return;
    setBusy(true); setVerify(null);
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    const label = `${submenu.cgi}.cgi › ${submenu.name} · ${action.name}`;
    if (multi) {
      const view = submenu.actions.find(a => a.name === 'view');
      const ch = sendable.Channel;
      const verifyQuery = risk !== 'read' && view && Object.keys(sendable).length ? buildQuery(submenu, 'view', ch !== undefined ? { Channel: ch } : {}) : undefined;
      try {
        const r = await api.batch({ deviceIds: fleet.map(d => d.id), path, query, accept, confirmed, verifyQuery }, ac.signal);
        const mismatches: Record<string, [string, string, string][] | null> = {};
        if (verifyQuery) for (const it of r.results) {
          if (!it.result) continue;
          if (!it.readback || it.readback.status !== 200 || !it.readback.body) { if (it.result.status === 200) mismatches[it.deviceId] = null; continue; }
          const got = prefillFrom(it.readback.body, action.params, ch);
          mismatches[it.deviceId] = Object.entries(sendable).filter(([n]) => n !== 'Channel' && got[n] !== undefined && String(got[n]).toLowerCase() !== String(sendable[n]).toLowerCase()).map(([n, v]) => [n, v, got[n]] as [string, string, string]);
        }
        setShown(null);
        setFleetRun({ label, action: action.name, ms: r.ms, items: r.results, mismatches: verifyQuery ? mismatches : undefined });
        const mine = r.results.find(i => i.deviceId === device.id);
        if (action.name === 'view' && mine?.result?.status === 200 && mine.result.bodyEncoding === 'utf8') setLastView(o => ({ ...o, [`${submenu.cgi}/${submenu.name}`]: mine.result!.body }));
        if (risk !== 'read' && mine?.result?.status === 200) setBaselines(o => ({ ...o, [k]: { ...(o[k] || {}), ...sendable } }));
      } catch (e) {
        if ((e as Error).name !== 'AbortError') { setFleetRun(null); setShown({ status: 0, body: '', error: (e as Error).message, label }); }
      } finally { setBusy(false); onSent(); }
      return;
    }
    setFleetRun(null);
    try {
      const r: SunapiResult = await api.request(device.id, { path, query, accept, confirmed }, ac.signal);
      setShown({ ...r, label });
      if (action.name === 'view' && r.status === 200 && r.bodyEncoding === 'utf8') setLastView(o => ({ ...o, [`${submenu.cgi}/${submenu.name}`]: r.body }));
      if (risk !== 'read' && r.status === 200) setBaselines(o => ({ ...o, [k]: { ...(o[k] || {}), ...sendable } }));
      // After a change, read the submenu back and check the device kept what was sent.
      const view = submenu.actions.find(a => a.name === 'view');
      const ok = r.status === 200 && !(parseBody(r.body).kind === 'json' && /Fail/.test(r.body.slice(0, 200)));
      if (risk !== 'read' && ok && view && Object.keys(sendable).length) {
        const ch = sendable.Channel;
        const vq = buildQuery(submenu, 'view', ch !== undefined ? { Channel: ch } : {});
        const back = await api.request(device.id, { path, query: vq, accept: 'json', origin: 'verify' });
        if (back.status === 200) {
          setLastView(o => ({ ...o, [`${submenu.cgi}/${submenu.name}`]: back.body }));
          const got = prefillFrom(back.body, action.params, ch);
          const checked = Object.entries(sendable).filter(([n]) => n !== 'Channel' && got[n] !== undefined);
          const mismatched = checked.filter(([n, v]) => String(got[n]).toLowerCase() !== String(v).toLowerCase()).map(([n, v]) => [n, v, got[n]] as [string, string, string]);
          setVerify({ ok: checked.length - mismatched.length, total: checked.length, mismatched });
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setShown({ status: 0, body: '', error: (e as Error).message, label });
    } finally { setBusy(false); onSent(); }
  }, [device, submenu, action, api, path, query, accept, risk, sendable, onSent, k, multi, fleet]);

  const send = () => {
    if (!device || !online || busy || !submenu || !action || Object.keys(errors).length || templatedUnfilled.length || nothingChanged) return;
    if (risk === 'read') return doSend(false);
    if (risk === 'change' && skipConfirm) return doSend(true);
    setUnderstood(false); setConfirm({ query });
  };

  // keyboard: Ctrl/Cmd+Enter sends, "/" focuses search
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
      else if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (!catalog) return null;
  const toggleFav = (s: Submenu) => { const id = `${s.cgi}/${s.name}`; setFavs(f => (f.includes(id) ? f.filter(x => x !== id) : [...f, id])); };
  const pick = (s: Submenu) => { setSel({ cgi: s.cgi, sub: s.name }); setShowReturns(false); };

  // ------------------------------------------------------------ render
  return (
    <div className="flex h-full min-h-0">
      {/* catalog */}
      <aside className="w-[264px] shrink-0 flex flex-col min-h-0 border-r border-hv-line">
        <div className="p-3 pb-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-hv-text-3" />
            <Input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search menus and fields" className="pl-8 pr-8"
              onKeyDown={e => { if (e.key === 'Escape') setQ(''); if (e.key === 'Enter' && filtered[0]) pick(filtered[0].subs[0].s); }} />
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-hv-text-3 ring-1 ring-hv-line-strong rounded px-1">/</kbd>
          </div>
          <div className="text-[11px] text-hv-text-3 mt-1.5 px-0.5">{catalog.cgis.length} CGIs · {catalog.submenuCount} menus · {catalog.actionCount} actions</div>
        </div>
        <nav className="flex-1 min-h-0 overflow-auto px-2 pb-3 text-sm">
          {!term && favSubs.length > 0 && (
            <div className="mb-2">
              <div className="px-2 h-7 flex items-center text-[11px] font-bold uppercase tracking-wide text-hv-text-3">Favorites</div>
              {favSubs.map(s => <TreeRow key={`f-${s.cgi}/${s.name}`} s={s} showCgi active={sel?.cgi === s.cgi && sel.sub === s.name} fav onPick={pick} onFav={toggleFav} />)}
            </div>
          )}
          {filtered.map(({ c, subs }) => {
            const isOpen = !!term || open[c.name];
            return (
              <div key={c.name}>
                <button onClick={() => setOpen(o => ({ ...o, [c.name]: !o[c.name] }))}
                  className="w-full h-8 flex items-center gap-1.5 px-2 rounded-hv-xs text-hv-text-2 hover:bg-hv-widget">
                  {isOpen ? <ChevronDown size={14} className="text-hv-text-3" /> : <ChevronRight size={14} className="text-hv-text-3" />}
                  <span className="font-semibold">{c.name}</span><span className="text-hv-text-3 text-xs">.cgi</span>
                  <span className="ml-auto text-[11px] text-hv-text-3">{subs.length}</span>
                </button>
                {isOpen && subs.map(({ s, why }) => (
                  <TreeRow key={s.name} s={s} why={why} active={sel?.cgi === s.cgi && sel.sub === s.name} fav={favs.includes(`${s.cgi}/${s.name}`)} onPick={pick} onFav={toggleFav} />
                ))}
              </div>
            );
          })}
          {!filtered.length && <div className="px-2 py-6 text-xs text-hv-text-3 text-center">Nothing matches “{q}”.</div>}
        </nav>
      </aside>

      {/* request + response */}
      {!submenu || !action ? (
        <div className="flex-1"><Empty icon={<FileText size={28} />} title="Pick a menu on the left">Every CGI, menu and field this device supports comes from its own attributes.cgi. Press <b>/</b> to search — field names work too (try “Brightness”).</Empty></div>
      ) : (
        <div className="flex-1 min-w-0 flex flex-col xl:flex-row min-h-0">
          <section className="xl:w-[440px] xl:shrink-0 flex flex-col min-h-0 max-h-[55%] xl:max-h-none border-b xl:border-b-0 xl:border-r border-hv-line">
            {/* title + actions */}
            <div className="px-4 pt-3 pb-2.5 border-b border-hv-line">
              <div className="flex items-center gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] text-hv-text-3 font-mono">{submenu.cgi}.cgi</div>
                  <h3 className="text-base font-bold text-hv-text truncate">{submenu.name}</h3>
                </div>
                <IconButton className="ml-auto" label={favs.includes(`${submenu.cgi}/${submenu.name}`) ? 'Remove from favorites' : 'Add to favorites'} active={favs.includes(`${submenu.cgi}/${submenu.name}`)} onClick={() => toggleFav(submenu)}>
                  <Star size={15} fill={favs.includes(`${submenu.cgi}/${submenu.name}`) ? 'currentColor' : 'none'} />
                </IconButton>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {submenu.actions.map(a => {
                  const on = a.name === action.name;
                  return (
                    <button key={a.name} onClick={() => { setActionName(a.name); setVerify(null); setPrefillNote(null); }}
                      className={cx('h-7 px-2.5 rounded-hv-xs text-xs font-semibold ring-1 ring-inset transition-colors',
                        on ? ({ info: 'bg-hv-info-tint text-hv-info-fg ring-hv-info/60', warning: 'bg-hv-warning-tint text-hv-warning-fg ring-hv-warning/60', error: 'bg-hv-error-tint text-hv-error-fg ring-hv-error/60', purple: 'bg-hv-purple-tint text-hv-purple-fg ring-hv-purple/60' } as Record<string, string>)[actionTone(a.name)] || 'bg-hv-box text-hv-text ring-hv-line-strong'
                          : 'text-hv-text-3 ring-hv-line hover:text-hv-text-2 hover:ring-hv-line-strong')}>
                      {a.name}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 mt-2 text-[11px] text-hv-text-3">
                {action.access && <span>Needs <b className="text-hv-text-2">{action.access}</b></span>}
                <span>·</span><span>{reqParams.length} input{reqParams.length === 1 ? '' : 's'}</span>
                {resParams.length > 0 && <><span>·</span><button className="underline decoration-dotted hover:text-hv-text-2" onClick={() => setShowReturns(s => !s)}>returns {resParams.length} field{resParams.length === 1 ? '' : 's'}</button></>}
              </div>
            </div>

            {/* inputs */}
            <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-3">
              {risk !== 'read' && (
                <div className={cx('flex items-start gap-2 rounded-hv-xs px-3 py-2 text-xs ring-1 ring-inset', risk === 'danger' ? 'bg-hv-error-tint ring-hv-error/40 text-hv-text' : 'bg-hv-warning-tint ring-hv-warning/40 text-hv-text')}>
                  <ShieldAlert size={15} className={cx('mt-px shrink-0', risk === 'danger' ? 'text-hv-error-fg' : 'text-hv-warning-fg')} />
                  <span>{risk === 'danger' ? (DANGER_NOTE[submenu.name.toLowerCase()] || 'This can disrupt the device.') + ' You will be asked to confirm.' : `${HARDWARE_NOTE[submenu.name.toLowerCase()] ? HARDWARE_NOTE[submenu.name.toLowerCase()] + ' ' : ''}This changes ${multi ? `${fleet.length} devices` : 'the device'}. You will see exactly what is sent before it goes.`}</span>
                </div>
              )}
              {risk !== 'read' && submenu.actions.some(a => a.name === 'view') && (
                <div className="flex items-center gap-2">
                  <Button size="sm" icon={<Wand2 size={13} />} disabled={!lastViewBody} onClick={prefill} title={lastViewBody ? '' : 'Run “view” on this menu first'}>Fill from current values</Button>
                  {!lastViewBody && <span className="text-[11px] text-hv-text-3">Run <button className="underline" onClick={() => setActionName('view')}>view</button> first</span>}
                </div>
              )}
              {prefillNote && <div className="text-[11px] text-hv-info-fg">{prefillNote}</div>}

              {reqParams.length === 0 && <div className="text-xs text-hv-text-3">No inputs — just send it.</div>}
              {reqParams.map(p => (
                <ParamRow key={p.name} p={p} value={vals[p.name] ?? ''} error={errors[p.name] as string | undefined}
                  same={isSame(p.name, vals[p.name] ?? '')} changed={base[p.name] !== undefined && (vals[p.name] ?? '') !== base[p.name]}
                  nameOverride={names[p.name]} onName={v => setKey(p.name, v)} onChange={v => setVal(p.name, v)} maxChannel={catalog.maxChannel} />
              ))}

              {/* extra params */}
              <div className="pt-1">
                {extras.map(([ek, ev], i) => (
                  <div key={i} className="flex items-center gap-1.5 mb-1.5">
                    <Input mono value={ek} placeholder="Name" onChange={e => setExtra(o => ({ ...o, [k]: extras.map((x, j) => (j === i ? [e.target.value, x[1]] : x)) }))} className="w-[44%]" />
                    <span className="text-hv-text-3">=</span>
                    <Input mono value={ev} placeholder="Value" onChange={e => setExtra(o => ({ ...o, [k]: extras.map((x, j) => (j === i ? [x[0], e.target.value] : x)) }))} />
                    <IconButton label="Remove" onClick={() => setExtra(o => ({ ...o, [k]: extras.filter((_, j) => j !== i) }))}><Trash2 size={14} /></IconButton>
                  </div>
                ))}
                <button className="inline-flex items-center gap-1 text-xs text-hv-text-3 hover:text-hv-text-2" onClick={() => setExtra(o => ({ ...o, [k]: [...extras, ['', '']] }))}><Plus size={13} /> Add a parameter not in the list</button>
              </div>

              {showReturns && resParams.length > 0 && (
                <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line p-2.5">
                  <div className="text-[11px] font-bold text-hv-text-3 mb-1.5">Fields the device returns</div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-[12px]">
                    {resParams.map(p => <React.Fragment key={p.name}><span className="font-mono text-hv-text-2 truncate" title={p.name}>{p.name}</span><span className="text-hv-text-3 text-right truncate max-w-[150px]" title={p.values?.join(', ')}>{typeHint(p)}</span></React.Fragment>)}
                  </div>
                </div>
              )}
            </div>

            {/* url + send */}
            <div className="border-t border-hv-line px-4 py-3 space-y-2.5 bg-hv-widget-panel">
              <div className="flex items-start gap-2">
                <code className="flex-1 min-w-0 font-mono text-[12px] leading-relaxed text-hv-text-2 break-all max-h-[4.5rem] overflow-auto">
                  <span className="text-hv-text-3">{path}?</span>{query}
                </code>
                <IconButton label="Copy URL" onClick={() => copyText(fullUrl)}><Link2 size={14} /></IconButton>
                <IconButton label="Copy as curl" onClick={() => copyText(`curl --digest -u '${device?.user || 'admin'}:PASSWORD'${device?.https ? ' -k' : ''} '${fullUrl}'`)}><Terminal size={14} /></IconButton>
              </div>
              <div className="flex items-center gap-2">
                <Segmented value={accept} onChange={setAccept} items={[{ id: 'json', label: 'JSON', title: 'Ask the device for JSON' }, { id: 'text', label: 'Text', title: 'Ask for classic Key=Value text' }]} />
                <IconButton label="Clear inputs" onClick={clearAll}><RotateCcw size={14} /></IconButton>
                <div className="ml-auto flex items-center gap-2">
                  {busy && <Button size="sm" tone="ghost" onClick={() => { abortRef.current?.abort(); setBusy(false); }}>Cancel</Button>}
                  <Button tone={risk === 'danger' ? 'danger' : 'primary'} busy={busy} icon={<Send size={14} />} onClick={send}
                    disabled={!device || !online || !!Object.keys(errors).length || templatedUnfilled.length > 0 || nothingChanged}
                    title={!device ? 'Add a device to send' : !online ? 'Connect to the device first' : 'Ctrl+Enter'}>
                    {risk === 'read' ? (multi ? `Send to ${fleet.length}` : 'Send') : `Send ${action.name}${multi ? ` to ${fleet.length}` : ''}…`}
                  </Button>
                </div>
              </div>
              {nothingChanged && <div className="text-[11px] text-hv-text-3">Nothing changed yet — edit a field to send.</div>}
              {templatedUnfilled.length > 0 && <div className="text-[11px] text-hv-error-fg">Replace the &lt;placeholder&gt; / # in {templatedUnfilled.map(p => p.name).join(', ')}.</div>}
              {!device && <div className="text-[11px] text-hv-text-3">Browsing a file — add a device to send requests.</div>}
              {multi && (
                <div className="flex items-start gap-2 text-[11px] text-hv-text-3">
                  <span className="flex -space-x-1 pt-0.5">{fleet.slice(0, 5).map(d => <span key={d.id} className="w-4 h-4 rounded-full bg-hv-box ring-1 ring-hv-widget-panel flex items-center justify-center"><KindIcon kind={d.kind} size={9} /></span>)}</span>
                  <span>Goes to <b className="text-hv-text-2">{fleet.length} devices</b> at once{risk !== 'read' && Object.keys(base).length > 0 && <label className="flex items-center gap-1.5 mt-1 cursor-pointer"><input type="checkbox" checked={sendAll} onChange={e => setSendAll(e.target.checked)} className="accent-[rgb(var(--hv-brand))]" />Also send unchanged fields, so every device matches {device?.name}</label>}</span>
                </div>
              )}
            </div>
          </section>

          {/* response */}
          <section className="flex-1 min-w-0 min-h-0 flex flex-col">
            {verify && (
              <div className={cx('mx-4 mt-3 flex items-start gap-2 rounded-hv-xs px-3 py-2 text-sm ring-1 ring-inset', verify.mismatched.length ? 'bg-hv-warning-tint ring-hv-warning/40' : 'bg-hv-success-tint ring-hv-success/40')}>
                {verify.mismatched.length ? <XCircle size={16} className="mt-0.5 shrink-0 text-hv-warning-fg" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-hv-success-fg" />}
                <div className="text-hv-text">
                  {verify.total === 0 ? 'Sent. The device’s view doesn’t list these fields, so they could not be read back.'
                    : verify.mismatched.length === 0 ? <>Read back: all {verify.total} value{verify.total === 1 ? '' : 's'} stuck.</>
                      : <>Read back: {verify.ok} of {verify.total} stuck. {verify.mismatched.map(([n, want, got]) => <span key={n} className="block font-mono text-xs mt-0.5">{n}: sent <b>{want}</b>, device has <b>{got}</b></span>)}</>}
                </div>
              </div>
            )}
            {fleetRun ? (
              <div className="flex-1 min-h-0"><FleetResults run={fleetRun} /></div>
            ) : shown ? (
              <>
                {shown.label && <div className="px-4 pt-3 text-[11px] text-hv-text-3 font-mono truncate">{shown.label}</div>}
                <div className="flex-1 min-h-0"><ResponseView r={shown} fileBase={`${device?.name || 'device'}-${submenu.cgi}-${submenu.name}`.replace(/[^\w.-]+/g, '_')}
                  actions={shown.status === 200 && risk === 'read' && submenu.actions.some(a => a.name === 'set') ? (
                    <Button size="sm" tone="ghost" icon={<Eye size={13} />} onClick={() => { setActionName('set'); setTimeout(() => { const act = submenu.actions.find(a => a.name === 'set'); if (act && shown.body) { const pf = prefillFrom(shown.body, act.params, vals.Channel); setValues(o => ({ ...o, [key(submenu, 'set')]: pf })); setBaselines(o => ({ ...o, [key(submenu, 'set')]: pf })); setPrefillNote(`Loaded ${Object.keys(pf).length} current values. Only the fields you change are sent.`); } }, 0); }}>Edit these values</Button>
                  ) : undefined} /></div>
              </>
            ) : (
              <Empty icon={<Info size={26} />} title="No answer yet">
                {risk === 'read' ? <>Press <b>Send</b> or <b>Ctrl+Enter</b>. The Pi makes the call (digest auth included) and shows it here as a table, JSON or raw text{multi ? <> — with {fleet.length} devices selected, as a side-by-side comparison</> : ''}.</> : <>Fill only what you want to change — empty fields are left out of the request.</>}
              </Empty>
            )}
          </section>
        </div>
      )}

      {/* confirm */}
      <Dialog open={!!confirm} onClose={() => setConfirm(null)} width={560}
        title={<span className="inline-flex items-center gap-2">{risk === 'danger' ? <ShieldAlert size={18} className="text-hv-error-fg" /> : null}Send “{action?.name}” to {multi ? `${fleet.length} devices` : device?.name}?</span>}
        footer={<>
          <Button tone="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button tone={risk === 'danger' ? 'danger' : 'primary'} disabled={risk === 'danger' && !understood} onClick={() => { setConfirm(null); doSend(true); }}>{multi ? `Send to ${fleet.length} devices` : 'Send to device'}</Button>
        </>}>
        {submenu && (
          <div className="space-y-3">
            {risk === 'danger' && <div className="rounded-hv-xs bg-hv-error-tint ring-1 ring-inset ring-hv-error/40 px-3 py-2 text-hv-text">{DANGER_NOTE[submenu.name.toLowerCase()] || 'This can disrupt the device or remove data.'}</div>}
            {risk === 'change' && HARDWARE_NOTE[submenu.name.toLowerCase()] && <div className="rounded-hv-xs bg-hv-warning-tint ring-1 ring-inset ring-hv-warning/40 px-3 py-2 text-hv-text">{HARDWARE_NOTE[submenu.name.toLowerCase()]}</div>}
            <div>
              <div className="text-[11px] font-semibold text-hv-text-3 mb-1">{multi ? `${fleet.length} devices` : 'Device'}</div>
              <div className="space-y-0.5 max-h-36 overflow-auto">
                {fleet.map(d => <div key={d.id} className="flex items-center gap-2 text-hv-text"><KindIcon kind={d.kind} size={13} className="text-hv-text-3" />{d.name} <span className="text-hv-text-3">· {d.host}{d.model ? ` · ${d.model}` : ''}</span></div>)}
              </div>
              {multi && <div className="text-[11px] text-hv-text-3 mt-1">Devices whose model doesn’t have this menu are skipped. Each one is read back afterwards.</div>}
            </div>
            <div>
              <div className="text-[11px] font-semibold text-hv-text-3 mb-1">Changes</div>
              {Object.keys(sendable).length + extras.filter(e => e[0]).length === 0 ? <div className="text-hv-text-3">No parameters — the action runs with defaults.</div> : (
                <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line divide-y divide-hv-line">
                  {[...Object.entries(sendable), ...extras.filter(e => e[0])].map(([n, v]) => {
                    const before = lastViewBody ? flatPick(lastViewBody, n, sendable.Channel) : undefined;
                    return (
                      <div key={n} className="flex items-center gap-3 px-3 py-1.5 font-mono text-[12.5px]">
                        <span className="text-hv-text-3 min-w-0 truncate">{n}</span>
                        <span className="ml-auto text-right">
                          {before !== undefined && before !== v && <span className="text-hv-text-3 mr-1.5">{before} <span className="font-sans">→</span></span>}
                          <span className="text-hv-text font-semibold">{v}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <code className="block font-mono text-[11.5px] text-hv-text-3 break-all">{path}?{confirm?.query}</code>
            {risk === 'danger' ? (
              <label className="flex items-center gap-2 text-hv-text"><input type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)} className="accent-[rgb(var(--hv-error))]" /> I understand what this does to {multi ? `all ${fleet.length} devices` : device?.name}</label>
            ) : (
              <label className="flex items-center gap-2 text-hv-text-2"><input type="checkbox" checked={skipConfirm} onChange={e => setSkipConfirm(e.target.checked)} className="accent-[rgb(var(--hv-brand))]" /> Don’t ask again for ordinary changes until I leave this page</label>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
};

function flatPick(body: string, name: string, channel?: string): string | undefined {
  const f = flatBody(body);
  const ln = name.toLowerCase();
  const hit = Object.entries(f).find(([k]) => {
    const last = k.split(/[.\]]/).filter(Boolean).pop()?.toLowerCase();
    if (last !== ln) return false;
    if (channel === undefined) return true;
    return !/\[(\d+)\]/.test(k) || k.includes(`[${channel}]`);
  });
  return hit?.[1];
}

// ---------------------------------------------------------------- tree row
const ACTION_LETTER: Record<string, string> = { view: 'V', set: 'S', add: 'A', remove: 'R', update: 'U', control: 'C', 'add/update': 'A', check: 'K', install: 'I', test: 'T', monitor: 'M', monitordiff: 'M' };
const TreeRow: React.FC<{ s: Submenu; active: boolean; fav: boolean; why?: string; showCgi?: boolean; onPick: (s: Submenu) => void; onFav: (s: Submenu) => void }> = ({ s, active, fav, why, showCgi, onPick, onFav }) => (
  <div className={cx('group relative flex items-center rounded-hv-xs', active ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')}>
    {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-hv-brand" />}
    <button onClick={() => onPick(s)} className="flex-1 min-w-0 text-left pl-7 pr-1 py-1.5">
      <div className={cx('truncate', active ? 'text-hv-text font-semibold' : 'text-hv-text-2')}>{showCgi && <span className="text-hv-text-3">{s.cgi} › </span>}{s.name}</div>
      {why && <div className="text-[11px] text-hv-info-fg truncate font-mono">{why}</div>}
    </button>
    <span className="flex items-center gap-[3px] pr-1.5 group-hover:hidden">
      {s.actions.slice(0, 6).map(a => (
        <span key={a.name} title={a.name} className={cx('w-4 h-4 rounded-[3px] text-[9px] font-bold flex items-center justify-center',
          { info: 'bg-hv-info-tint text-hv-info-fg', warning: 'bg-hv-warning-tint text-hv-warning-fg', error: 'bg-hv-error-tint text-hv-error-fg', purple: 'bg-hv-purple-tint text-hv-purple-fg' }[actionTone(a.name) as 'info'] || 'bg-hv-widget text-hv-text-3')}>
          {ACTION_LETTER[a.name] || a.name[0].toUpperCase()}
        </span>
      ))}
    </span>
    <button onClick={() => onFav(s)} title={fav ? 'Remove from favorites' : 'Add to favorites'} className={cx('pr-2 hidden group-hover:block', fav ? 'text-hv-brand-fg' : 'text-hv-text-3 hover:text-hv-text')}>
      <Star size={13} fill={fav ? 'currentColor' : 'none'} />
    </button>
  </div>
);

// ---------------------------------------------------------------- param row
const ParamRow: React.FC<{ p: Param; value: string; error?: string; same?: boolean; changed?: boolean; nameOverride?: string; onName: (v: string) => void; onChange: (v: string) => void; maxChannel: number }> =
  ({ p, value, error, same, changed, nameOverride, onName, onChange, maxChannel }) => {
    const filled = value !== '' && !same;
    let control: React.ReactNode;
    if (p.name === 'Channel' && p.type === 'int' && maxChannel > 1 && maxChannel <= 64) {
      control = <Select value={value} onChange={e => onChange(e.target.value)}><option value="">All channels</option>{Array.from({ length: maxChannel }, (_, i) => <option key={i} value={i}>Channel {i}</option>)}</Select>;
    } else if (p.type === 'bool') {
      control = (
        <div className="inline-flex rounded-hv-xs ring-1 ring-inset ring-hv-line-strong p-0.5 bg-hv-surface">
          {[p.trueValue || 'True', p.falseValue || 'False'].map(v => (
            <button key={v} onClick={() => onChange(value.toLowerCase() === v.toLowerCase() ? '' : v)}
              className={cx('h-7 px-3 rounded-[3px] text-xs font-semibold', value.toLowerCase() === v.toLowerCase() ? (v.toLowerCase() === (p.trueValue || 'True').toLowerCase() ? 'bg-hv-success-tint text-hv-success-fg' : 'bg-hv-box text-hv-text') : 'text-hv-text-3 hover:text-hv-text-2')}>{v}</button>
          ))}
        </div>
      );
    } else if (p.type === 'enum' && p.values?.length) {
      control = <Select value={value} invalid={!!error} onChange={e => onChange(e.target.value)}><option value="">—</option>{p.values.map(v => <option key={v} value={v}>{v}</option>)}{value && !p.values.includes(value) && <option value={value}>{value}</option>}</Select>;
    } else if (p.type === 'csv' && p.values?.length) {
      const set = new Set(value ? value.split(',') : []);
      control = (
        <div className="flex flex-wrap gap-1">
          {p.values.map(v => {
            const on = set.has(v);
            return <button key={v} onClick={() => { const n = new Set(set); on ? n.delete(v) : n.add(v); onChange(p.values!.filter(x => n.has(x)).join(',')); }}
              className={cx('h-6 px-2 rounded-hv-xs text-[11px] font-semibold ring-1 ring-inset', on ? 'bg-hv-brand-tint text-hv-brand-fg ring-hv-brand/40' : 'text-hv-text-3 ring-hv-line hover:text-hv-text-2')}>{v}</button>;
          })}
        </div>
      );
    } else {
      const ph = p.type === 'int' || p.type === 'float' ? (p.min !== undefined || p.max !== undefined ? `${p.min ?? ''} – ${p.max ?? ''}` : p.type) : p.format || (p.maxlen ? `up to ${p.maxlen} characters` : '');
      control = <Input value={value} invalid={!!error} onChange={e => onChange(e.target.value)} placeholder={ph} inputMode={p.type === 'int' || p.type === 'float' ? 'decimal' : undefined} mono={p.type !== 'string'} />;
    }
    return (
      <div>
        <div className="flex items-baseline gap-2 mb-1">
          {p.templated ? (
            <input value={nameOverride ?? p.name} onChange={e => onName(e.target.value)} title="Replace the <placeholder> / # with a real value"
              className="flex-1 min-w-0 bg-transparent font-mono text-[12px] text-hv-info-fg border-b border-dashed border-hv-info/50 outline-none" />
          ) : (
            <span className={cx('font-mono text-[12px] truncate inline-flex items-center gap-1.5', filled ? 'text-hv-text font-semibold' : 'text-hv-text-2')} title={p.name}>
              {changed && <span className="w-1.5 h-1.5 rounded-full bg-hv-brand shrink-0" title="Changed — will be sent" />}{p.name}
            </span>
          )}
          {same && !error && <span className="text-[11px] text-hv-text-3">current</span>}
          <span className={cx('ml-auto text-[11px] whitespace-nowrap', error ? 'text-hv-error-fg font-semibold' : 'text-hv-text-3')}>{error || typeHint(p)}</span>
        </div>
        {control}
      </div>
    );
  };
