// AETHER_TRACE (TRACE-5) — Jira round trip on a run: pull a ticket's HAR in, send the run's results to the ticket.
import React, { useState } from 'react';
import { ChevronDown, Download, Loader2, Send } from 'lucide-react';
import { Button, Input, Toggle, lsGet, lsSet } from '../sunapi/ui';
import { fmtBytes } from '../sunapi/ui';
import type { JiraIssue, TraceApi } from './api';

const Pop: React.FC<{ open: boolean; onClose: () => void; children: React.ReactNode }> = ({ open, onClose, children }) => !open ? null : (
  <>
    <div className="fixed inset-0 z-40" onClick={onClose} />
    <div className="absolute right-0 z-50 mt-1 w-96 rounded-hv-xs bg-hv-popup-panel shadow-hv-2 ring-1 ring-hv-line-strong p-3 space-y-2 text-[12px]" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>{children}</div>
  </>
);

export const JiraButtons: React.FC<{ api: TraceApi; runId: string; admin: boolean; onImported: (text: string) => void; onError: (text: string) => void; onSent: (text: string) => void }> = ({ api, runId, admin, onImported, onError, onSent }) => {
  const [mode, setMode] = useState<'from' | 'to' | null>(null);
  const [key, setKey] = useState<string>(() => lsGet('aether.trace.jiraKey', ''));
  const [issue, setIssue] = useState<JiraIssue | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const look = async () => {
    setBusy('look'); setErr(null); setIssue(null); lsSet('aether.trace.jiraKey', key.trim().toUpperCase());
    try { setIssue(await api.jiraIssue(key.trim())); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const take = async (id: string, name: string) => {
    setBusy(id); setErr(null);
    try { const r = await api.importJira(runId, key.trim(), id); setMode(null); onImported(`${r.from}: ${r.imported} events added`); }
    catch (e) { setErr((e as Error).message); onError((e as Error).message); } finally { setBusy(null); }
    void name;
  };
  const send = async () => {
    setBusy('send'); setErr(null); lsSet('aether.trace.jiraKey', key.trim().toUpperCase());
    try { const r = await api.sendJira(runId, key.trim(), comment); setMode(null); onSent(`Sent to ${r.key}: ${r.attached.map(a => a.filename).join(', ')}${r.commented ? ' and a summary comment' : ''}`); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  if (!admin) return null;   // the Jira login is the admin's: both directions use it
  return (
    <>
      <div className="relative">
        <Button size="sm" icon={<Download size={13} />} onClick={() => { setMode(mode === 'from' ? null : 'from'); setErr(null); }} title="Pull a .har attached to a Jira ticket into this run (the Pi downloads it)">From Jira <ChevronDown size={12} /></Button>
        <Pop open={mode === 'from'} onClose={() => setMode(null)}>
          <div className="flex gap-2"><Input autoFocus placeholder="Issue key, e.g. OCF-7412" value={key} onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') look(); }} /><Button size="sm" busy={busy === 'look'} onClick={look}>Look</Button></div>
          {issue && <div className="text-hv-text"><b>{issue.key}</b> {issue.summary}{issue.status ? <span className="text-hv-text-3"> · {issue.status}</span> : null}</div>}
          {issue && !issue.hars.length && <div className="text-hv-text-3">No .har attached ({issue.attachments.length} other attachment{issue.attachments.length === 1 ? '' : 's'}).</div>}
          {issue && issue.hars.map(h => (
            <button key={h.id} className="w-full text-left rounded-hv-xs px-2 py-1 hover:bg-hv-box flex items-center gap-2" disabled={!!busy} onClick={() => take(h.id, h.filename)}>
              {busy === h.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} className="text-hv-text-3" />}
              <span className="text-hv-text truncate flex-1">{h.filename}</span><span className="text-hv-text-3">{fmtBytes(h.size)}{h.created && !isNaN(Date.parse(h.created)) ? ` · ${new Date(h.created).toLocaleDateString()}` : ''}{h.author ? ` · ${h.author}` : ''}</span>
            </button>
          ))}
          {err && <div className="text-hv-error-fg">{err}</div>}
        </Pop>
      </div>
      {admin && (
        <div className="relative">
          <Button size="sm" icon={<Send size={13} />} onClick={() => { setMode(mode === 'to' ? null : 'to'); setErr(null); }} title="Attach this run's results to a Jira ticket">To Jira <ChevronDown size={12} /></Button>
          <Pop open={mode === 'to'} onClose={() => setMode(null)}>
            <Input autoFocus placeholder="Issue key, e.g. OCF-7412" value={key} onChange={e => setKey(e.target.value)} />
            <div className="text-hv-text-3">Attaches the traces CSV, the test CSV (for a test run) and a summary JSON. Payloads stay on the Pi.</div>
            <Toggle on={comment} onChange={setComment} label="Also add a short summary comment" />
            {err && <div className="text-hv-error-fg">{err}</div>}
            <Button tone="primary" className="w-full" busy={busy === 'send'} disabled={!key.trim()} onClick={send}>Send to {key.trim().toUpperCase() || 'Jira'}</Button>
          </Pop>
        </div>
      )}
    </>
  );
};
