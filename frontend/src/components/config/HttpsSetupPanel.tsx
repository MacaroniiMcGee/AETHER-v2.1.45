// Setup › HTTPS & Domain — AETHER_HTTPS (bundle "https-1")
// A real Let's Encrypt certificate for <name>.<domain>, obtained and renewed by this
// Pi through Cloudflare DNS. Backend: backend/lib/httpsManager.js (/api/https/*).
// The Cloudflare token is sent once to the Pi and never shown again.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, ShieldCheck, ShieldAlert, Loader2, ExternalLink, CheckCircle, AlertTriangle, KeyRound, RefreshCw, Globe } from 'lucide-react';
import { T, Card, Btn, inputCls, inputStyle, KV } from './ui';

type Step = { t: number; msg: string; level: 'info' | 'warn' | 'error' | 'ok' };
type Status = {
  success: boolean;
  config: { domain: string; host: string; fqdn: string; email: string; agreed: boolean; staging: boolean; redirect: boolean; ipOverride: string; tokenSet: boolean };
  https: { listening: boolean; port: number | null; error: string | null; url: string | null; certSource: 'letsencrypt' | 'self-signed' | 'none' };
  letsencrypt: null | { names: string[]; validTo: string; daysLeft: number; issuer: string; staging: boolean; usable: boolean };
  dns: { ip: string | null; ips: string[]; recordIp: string | null; recordFor: string | null; lastSync: number | null; error: string | null };
  lastIssueAt: number | null; lastIssueError: string | null; nextTryAt: number | null;
  browserVerified: boolean; redirectActive: boolean;
  job: { running: boolean; steps: Step[]; error: string | null; ok: boolean | null; startedAt: number | null; finishedAt: number | null };
};
type Msg = { tone: 'ok' | 'err' | 'warn'; text: React.ReactNode } | null;

const DEFAULT_DOMAIN = 'aetheraccesstools.com';
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const fmtWhen = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : '—');

async function postJson(url: string, body?: any) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.success === false) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return j;
}

function Banner({ msg }: { msg: Msg }) {
  if (!msg) return null;
  const c = msg.tone === 'ok' ? T.green : msg.tone === 'warn' ? T.warn : T.crit;
  return (
    <div className="rounded-lg border px-3 py-2 text-sm flex items-start gap-2" style={{ borderColor: c, color: T.text, background: T.well }}>
      {msg.tone === 'ok' ? <CheckCircle size={16} style={{ color: c }} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} style={{ color: c }} className="mt-0.5 shrink-0" />}
      <div className="min-w-0">{msg.text}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold mb-1" style={{ color: T.text2 }}>{label}</span>
      {children}
      {hint && <span className="block text-[11px] mt-1" style={{ color: T.dim }}>{hint}</span>}
    </label>
  );
}

function StepNo({ n, done }: { n: number; done: boolean }) {
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold shrink-0"
      style={{ background: done ? 'rgb(var(--hv-success-tint-strong))' : 'rgb(var(--hv-widget-panel))', color: done ? 'rgb(var(--hv-success-text))' : T.text2, border: `1px solid ${done ? T.green : T.line2}` }}>
      {done ? '✓' : n}
    </span>
  );
}

export default function HttpsSetupPanel({ api }: { api: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [form, setForm] = useState({ domain: '', host: '', email: '', agreed: false, staging: false, redirect: true, ipOverride: '' });
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [dirty, setDirty] = useState(false);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${api}/api/https/status`, { cache: 'no-store' });
      if (r.status === 404) { setLoadErr('The backend does not have HTTPS support yet (restart it after the update).'); return; }
      const j: Status = await r.json();
      if (!j.success) throw new Error('bad status');
      setSt(j); setLoadErr(null);
      if (!loadedOnce.current) {
        loadedOnce.current = true;
        setForm({ domain: j.config.domain || DEFAULT_DOMAIN, host: j.config.host || 'bench1', email: j.config.email || '', agreed: j.config.agreed,
          staging: j.config.staging, redirect: j.config.redirect, ipOverride: j.config.ipOverride || '' });
        if (!j.config.domain) setDirty(true);
      }
    } catch (e: any) { setLoadErr(`Can't reach the Pi: ${e?.message || e}`); }
  }, [api]);

  useEffect(() => { load(); }, [load]);
  const running = !!st?.job.running;
  useEffect(() => { const t = setInterval(load, running ? 1500 : 10000); return () => clearInterval(t); }, [load, running]);

  const set = (k: keyof typeof form, v: any) => { setForm(f => ({ ...f, [k]: v })); setDirty(true); };

  const domainOk = DOMAIN_RE.test(form.domain.trim().toLowerCase());
  const hostOk = HOST_RE.test(form.host.trim().toLowerCase());
  const fqdn = domainOk && hostOk ? `${form.host.trim().toLowerCase()}.${form.domain.trim().toLowerCase()}` : '';

  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const body: any = { ...form, domain: form.domain.trim().toLowerCase(), host: form.host.trim().toLowerCase(), email: form.email.trim() };
      if (token.trim()) body.token = token.trim();
      const j = await postJson(`${api}/api/https/config`, body);
      setSt(j); setDirty(false); setToken('');
      setMsg({ tone: 'ok', text: token.trim() ? 'Saved. The Cloudflare token works and is stored on the Pi only.' : 'Saved.' });
    } catch (e: any) { setMsg({ tone: 'err', text: e.message }); }
    setBusy(null);
  };

  const testToken = async () => {
    setBusy('test'); setMsg(null);
    try { await postJson(`${api}/api/https/token/test`); setMsg({ tone: 'ok', text: `The saved token can manage ${st?.config.domain}.` }); }
    catch (e: any) { setMsg({ tone: 'err', text: e.message }); }
    setBusy(null);
  };

  const removeToken = async () => {
    setBusy('clear'); setMsg(null);
    try { const j = await postJson(`${api}/api/https/token/clear`); setSt(j); setMsg({ tone: 'warn', text: 'Token removed from the Pi. Renewals stop until a new one is saved; the current certificate keeps working until it expires.' }); }
    catch (e: any) { setMsg({ tone: 'err', text: e.message }); }
    setBusy(null);
  };

  const issue = async () => {
    setBusy('issue'); setMsg(null);
    try { const j = await postJson(`${api}/api/https/issue`); setSt(j); }
    catch (e: any) { setMsg({ tone: 'err', text: e.message }); }
    setBusy(null);
  };

  const secureBase = st?.config.fqdn && st.https.port ? `https://${st.config.fqdn}${st.https.port === 443 ? '' : ':' + st.https.port}` : '';

  const check = async () => {
    if (!secureBase) return;
    setBusy('check'); setMsg(null);
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(`${secureBase}/api/https/ping`, { cache: 'no-store', signal: ctl.signal }).finally(() => clearTimeout(t));
      const j = await r.json();
      if (!j?.success || j.fqdn !== st?.config.fqdn) throw new Error('unexpected answer');
      const s = await postJson(`${api}/api/https/browser-ok`, { origin: secureBase });
      setSt(s);
      setMsg({ tone: 'ok', text: <>This browser reached <b>{secureBase}</b> with a trusted certificate.{s.config.redirect ? ' Opening the Pi by its IP now sends browsers to the secure address.' : ''}</> });
    } catch (e: any) {
      setMsg({ tone: 'err', text: <>
        This browser couldn't open <b>{secureBase}</b> ({e?.name === 'AbortError' ? 'timed out' : e?.message || 'failed'}). Nothing was changed. Common causes:
        <ul className="list-disc ml-5 mt-1 space-y-0.5">
          <li>The DNS name was just created: wait a minute and try again.</li>
          <li>The router blocks public names that point to local addresses (DNS rebinding protection). Allow <b>{st?.config.domain}</b> in the router's DNS settings.</li>
          <li>This computer has no internet DNS (fully isolated network).</li>
        </ul>
      </> });
    }
    setBusy(null);
  };

  if (!st) {
    return <Card title="HTTPS & Domain"><div className="text-sm flex items-center gap-2" style={{ color: loadErr ? T.crit : T.dim }}>{loadErr ? <AlertTriangle size={15} /> : <Loader2 size={15} className="animate-spin" />}{loadErr || 'Loading…'}</div></Card>;
  }

  const le = st.letsencrypt;
  const real = !!le?.usable && st.https.certSource === 'letsencrypt';
  const onHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const tone = !st.https.listening ? T.crit : real && !le?.staging ? T.green : T.warn;
  const headline = !st.https.listening
    ? `HTTPS is not running${st.https.error ? ` (${st.https.error})` : ''}. The normal address still works.`
    : real && !le?.staging ? 'Secure: trusted certificate in use'
    : real && le?.staging ? 'HTTPS on with a TEST certificate (browsers will warn). Turn off "test server" and get a real one.'
    : 'HTTPS on with a temporary self-signed certificate (browsers will warn until a real one is issued)';
  const step1 = !!st.config.domain && !!st.config.host;
  const step2 = st.config.tokenSet;
  const step3 = !!real;
  const canIssue = step1 && step2 && st.config.agreed && !dirty;

  return (
    <div className="space-y-4">
      <Banner msg={msg} />
      <Card title={<span className="inline-flex items-center gap-2"><Lock size={15} /> Secure address</span>}
        right={<Btn onClick={load} title="Refresh"><RefreshCw size={14} /></Btn>}>
        <div className="flex items-start gap-3 mb-3">
          {real && !le?.staging ? <ShieldCheck size={22} style={{ color: tone }} className="shrink-0" /> : <ShieldAlert size={22} style={{ color: tone }} className="shrink-0" />}
          <div className="min-w-0">
            <div className="font-semibold text-sm" style={{ color: T.text }}>{headline}</div>
            {real && secureBase && (
              <a href={secureBase} className="inline-flex items-center gap-1 text-sm underline mt-0.5 break-all" style={{ color: T.blue }}>{secureBase} <ExternalLink size={13} /></a>
            )}
            {onHttps && <div className="text-xs mt-0.5" style={{ color: T.green }}>You are using this page over HTTPS now.</div>}
          </div>
        </div>
        <KV rows={[
          ['Certificate', le ? `${le.staging ? 'TEST · ' : ''}Let's Encrypt for ${le.names.join(', ')}, valid until ${le.validTo.slice(0, 10)} (${le.daysLeft} days)${le.usable ? '' : ' · not in use'}` : (st.https.certSource === 'self-signed' ? 'Self-signed (temporary)' : '—')],
          ['Renewal', le ? (st.config.tokenSet ? 'Automatic, when fewer than 30 days are left' : 'Off: no Cloudflare token saved') : '—'],
          ['DNS name', st.dns.recordFor ? `${st.dns.recordFor} → ${st.dns.recordIp} (updated ${fmtWhen(st.dns.lastSync)})` : '—'],
          ['This Pi', `${st.dns.ip || 'no LAN address'}${st.dns.ips.length > 1 ? ` (also ${st.dns.ips.filter(i => i !== st.dns.ip).join(', ')})` : ''}`],
          ['HTTPS port', st.https.port ? String(st.https.port) : '—'],
          ['Plain address', 'http://<this Pi>:3001 keeps working for tools and scripts'],
          ['Send browsers to HTTPS', st.redirectActive ? 'On' : st.config.redirect ? (real ? 'Waiting for "Check from this browser"' : 'After a trusted certificate is in use') : 'Off'],
        ]} />
        {(st.dns.error || st.lastIssueError) && !running && (
          <div className="mt-3 text-xs rounded-md border px-3 py-2" style={{ borderColor: 'rgb(var(--hv-error-hover))', color: T.text2 }}>
            {st.dns.error && <div><b>DNS update:</b> {st.dns.error}</div>}
            {st.lastIssueError && <div><b>Last certificate attempt:</b> {st.lastIssueError}{st.nextTryAt ? ` · retries on its own after ${fmtWhen(st.nextTryAt)}` : ''}</div>}
          </div>
        )}
        <div className="flex flex-wrap gap-2 mt-3">
          <Btn tone="primary" onClick={issue} disabled={!canIssue || running || busy !== null}
            title={!canIssue ? (dirty ? 'Save the settings first' : 'Finish steps 1 to 3 first') : undefined}>
            {running || busy === 'issue' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            {running ? 'Working…' : le?.usable ? 'Renew now' : 'Get certificate'}
          </Btn>
          {real && <Btn onClick={check} disabled={busy !== null}>{busy === 'check' ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />} Check from this browser</Btn>}
        </div>
        {(running || st.job.steps.length > 0) && (
          <ol className="mt-3 space-y-1 text-xs font-mono rounded-md border p-2" style={{ borderColor: T.line, background: T.well }}>
            {st.job.steps.map((s, i) => (
              <li key={i} style={{ color: s.level === 'error' ? T.crit : s.level === 'warn' ? T.warn : s.level === 'ok' ? T.green : T.text2 }}>
                {new Date(s.t).toLocaleTimeString()} · {s.msg}
              </li>
            ))}
            {running && <li className="flex items-center gap-1.5" style={{ color: T.dim }}><Loader2 size={12} className="animate-spin" /> usually 30–90 seconds</li>}
          </ol>
        )}
      </Card>

      <Card title="Setup" right={dirty ? <span className="text-xs" style={{ color: T.warn }}>Not saved</span> : undefined}>
        <div className="space-y-5">
          <div className="flex gap-3">
            <StepNo n={1} done={step1} />
            <div className="flex-1 grid gap-3 sm:grid-cols-2">
              <Field label="Domain (in Cloudflare)" hint={!domainOk && form.domain ? 'Example: example.com' : undefined}>
                <input className={inputCls} style={inputStyle} value={form.domain} onChange={e => set('domain', e.target.value)} placeholder={DEFAULT_DOMAIN} spellCheck={false} />
              </Field>
              <Field label="This Pi's name" hint={fqdn ? <>Address: <b>https://{fqdn}</b></> : 'Letters, numbers and dashes, e.g. bench1'}>
                <input className={inputCls} style={inputStyle} value={form.host} onChange={e => set('host', e.target.value)} placeholder="bench1" spellCheck={false} />
              </Field>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNo n={2} done={step2} />
            <div className="flex-1 space-y-2">
              <Field label="Cloudflare API token"
                hint={<>Cloudflare › My Profile › API Tokens › Create Token › <b>Edit zone DNS</b> template, add <b>Zone · Zone · Read</b>, limit it to this domain. It is checked, then kept on the Pi only (never shown again).</>}>
                <div className="flex gap-2">
                  <input className={inputCls} style={inputStyle} type="password" autoComplete="off" value={token}
                    onChange={e => { setToken(e.target.value); setDirty(true); }}
                    placeholder={st.config.tokenSet ? 'Saved on the Pi · paste a new one to replace it' : 'Paste the token'} />
                </div>
              </Field>
              {st.config.tokenSet && (
                <div className="flex flex-wrap gap-2 items-center text-xs" style={{ color: T.green }}>
                  <KeyRound size={13} /> Token saved on the Pi
                  <Btn onClick={testToken} disabled={busy !== null}>{busy === 'test' ? <Loader2 size={13} className="animate-spin" /> : null}Test it</Btn>
                  <Btn tone="danger" onClick={removeToken} disabled={busy !== null || running}>Remove</Btn>
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-3">
            <StepNo n={3} done={st.config.agreed} />
            <div className="flex-1 space-y-2">
              <Field label="Email for expiry warnings (optional)" hint="Let's Encrypt only emails if renewal keeps failing.">
                <input className={inputCls} style={inputStyle} value={form.email} onChange={e => set('email', e.target.value)} placeholder="you@example.com" />
              </Field>
              <label className="flex items-start gap-2 text-sm" style={{ color: T.text2 }}>
                <input type="checkbox" className="mt-1" checked={form.agreed} onChange={e => set('agreed', e.target.checked)} />
                <span>I accept the <a className="underline" style={{ color: T.blue }} href="https://letsencrypt.org/repository/" target="_blank" rel="noreferrer">Let's Encrypt Subscriber Agreement</a>.</span>
              </label>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNo n={4} done={step3} />
            <div className="flex-1 text-sm" style={{ color: T.text2 }}>
              Save, then press <b>Get certificate</b> above. When it's done, press <b>Check from this browser</b>.
            </div>
          </div>

          <details className="text-sm" style={{ color: T.text2 }}>
            <summary className="cursor-pointer select-none text-xs font-semibold" style={{ color: T.dim }}>More options</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Address the name points to" hint="Normally this Pi's own address, chosen automatically.">
                <select className={inputCls} style={inputStyle} value={form.ipOverride} onChange={e => set('ipOverride', e.target.value)}>
                  <option value="">Automatic{st.dns.ips[0] ? ` (${st.dns.ips[0]})` : ''}</option>
                  {st.dns.ips.map(ip => <option key={ip} value={ip}>{ip}</option>)}
                  {form.ipOverride && !st.dns.ips.includes(form.ipOverride) && <option value={form.ipOverride}>{form.ipOverride}</option>}
                </select>
              </Field>
              <div className="space-y-2 pt-1">
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={form.redirect} onChange={e => set('redirect', e.target.checked)} />
                  <span>Send browsers that open the Pi by its IP to the secure address (only after a successful browser check; add <code>?http=1</code> to stay on HTTP).</span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={form.staging} onChange={e => set('staging', e.target.checked)} />
                  <span>Use Let's Encrypt's test server (for troubleshooting; browsers won't trust it).</span>
                </label>
              </div>
            </div>
          </details>

          <div className="flex justify-end">
            <Btn tone="primary" onClick={save} disabled={busy !== null || running || !domainOk || !hostOk || !dirty}>
              {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />} {token.trim() ? 'Check token & save' : 'Save'}
            </Btn>
          </div>
        </div>
      </Card>
    </div>
  );
}
