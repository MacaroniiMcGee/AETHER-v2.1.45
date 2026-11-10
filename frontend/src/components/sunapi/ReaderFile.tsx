// AETHER_SUNAPI — Reader file tab (SUNAPI-3): send reader firmware or a reader config file
// through an access controller, which passes it to one OSDP reader (osdp_FILETRANSFER).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Library, Send, AlertTriangle, CheckCircle2, XCircle, Loader2, Copy, Cpu, Clock, FileCog } from 'lucide-react';
import type { Client, Device, HistoryEntry, LibraryFile, ReaderFileJob } from './api';
import { Badge, Button, Field, Input, Segmented, copyText, cx, fmtBytes, fmtTime, lsGet, lsSet } from './ui';
import { ResponseView } from './ResponseView';

type Source = 'library' | 'upload';
type Call = 'install' | 'custom';
type FileType = 'firmware' | 'config';

const defaultQuery = (port: number, reader: number) => `msubmenu=credentialreader&action=install&Index=${port}&Reader.Index=${reader}`;
const OFFICIAL = (port: number, reader: number) => `msubmenu=credentialreader&action=control&Index=${port}&Reader.Index=${reader}&Mode=FileTransfer`;
const fmtDur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`; };
// Measured on this Pi, 1 Oct 2026: WaveLynx flash at 9600 baud moved 672 file bytes per second.
const BYTES_PER_S_9600 = 672;

export const ReaderFile: React.FC<{ api: Client; device: Device; tick?: number; onSent?: () => void }> = ({ api, device, onSent }) => {
  const saved = lsGet<{ port: number; reader: number; fileType: FileType; source: Source }>('aether.sunapi.readerfile', { port: 1, reader: 0, fileType: 'firmware', source: 'library' });
  const [port, setPort] = useState(saved.port);
  const [reader, setReader] = useState(saved.reader);
  const [fileType, setFileType] = useState<FileType>(saved.fileType);
  const [source, setSource] = useState<Source>(saved.source);
  const [library, setLibrary] = useState<LibraryFile[] | null>(null);
  const [libErr, setLibErr] = useState<string | null>(null);
  const [libraryId, setLibraryId] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [call, setCall] = useState<Call>('install');
  const [customQuery, setCustomQuery] = useState('');
  const [timeoutMin, setTimeoutMin] = useState(30);
  const [baudOk, setBaudOk] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [job, setJob] = useState<ReaderFileJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [past, setPast] = useState<HistoryEntry[]>([]);
  const [now, setNow] = useState(Date.now());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { lsSet('aether.sunapi.readerfile', { port, reader, fileType, source }); }, [port, reader, fileType, source]);
  useEffect(() => { setConfirming(false); setUnderstood(false); }, [port, reader, fileType, source, libraryId, file, call, customQuery]);

  useEffect(() => {
    api.firmwareLibrary().then(l => { setLibrary(l); if (!libraryId && l[0]) setLibraryId(l[0].id); }).catch(e => setLibErr(e.message));
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadPast = () => api.history(device.id).then(h => setPast(h.filter(x => x.origin === 'reader-file').slice(0, 10))).catch(() => {});
  useEffect(() => { setJob(null); setErr(null); api.readerFile(device.id).then(setJob).catch(() => {}); loadPast(); }, [api, device.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while a transfer runs; tick the clock for the elapsed time
  const running = job?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setNow(Date.now());
      api.readerFile(device.id).then(j => { setJob(j); if (j && j.state !== 'running') { loadPast(); onSent?.(); } }).catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [running, api, device.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const lib = library?.find(x => x.id === libraryId) || null;
  const chosen = source === 'upload' ? (file ? { name: file.name, bytes: file.size } : null) : (lib ? { name: lib.filename, bytes: lib.sizeBytes } : null);
  const query = call === 'custom' ? (customQuery || defaultQuery(port, reader)) : defaultQuery(port, reader);
  const portOk = Number.isInteger(port) && port >= 0 && port <= 64;
  const readerOk = Number.isInteger(reader) && reader >= 0 && reader <= 126;
  const ready = !!chosen && portOk && readerOk && (fileType === 'config' || baudOk) && !running;
  const host = `${device.https ? 'https' : 'http'}://${device.host}${device.port && device.port !== (device.https ? 443 : 80) ? ':' + device.port : ''}`;
  const root = device.cgiRoot || 'stw-cgi';
  const url = `${host}/${root}/accesscontrol.cgi?${query}`;
  const curl = `curl -v --digest -u "${device.user}" -X POST -H "Content-Type: application/octet-stream" -H "Expect:" --data-binary "@./${chosen?.name || 'FIRMWARE.bin'}" "${url}"${device.https ? ' -k' : ''}`;
  const est9600 = chosen ? chosen.bytes / BYTES_PER_S_9600 * 1000 : 0;

  const send = async () => {
    if (!chosen) return;
    setErr(null); setConfirming(false); setUnderstood(false);
    try {
      const j = await api.sendReaderFile(device.id, {
        portIndex: port, readerIndex: reader, fileType, timeoutMin,
        query: call === 'custom' ? query : undefined,
        file: source === 'upload' ? file || undefined : undefined,
        libraryId: source === 'library' ? libraryId : undefined,
      });
      setJob(j); setNow(Date.now());
    } catch (e: any) { setErr(e.message || String(e)); }
  };

  const elapsed = job ? (job.endedAt || now) - job.startedAt : 0;
  const waiting = job && job.sentAt ? (job.endedAt || now) - job.sentAt : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 flex flex-col gap-4">
        <div className="flex items-start gap-3 flex-wrap">
          <Cpu size={18} className="text-hv-brand-fg mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-hv-text">Send a file to a reader</h3>
            <p className="text-xs text-hv-text-2 max-w-3xl">
              {device.name} receives the file over the network and sends it to one OSDP reader with <span className="font-mono">osdp_FILETRANSFER</span>.
              Reader firmware or a reader configuration file. Uses the controller's temporary SUNAPI call until the official one is ready.
            </p>
          </div>
          {device.kind !== 'access' && <Badge tone="warning">This device isn't marked as access control</Badge>}
        </div>

        {/* Where */}
        <section className="rounded-hv-sm ring-1 ring-inset ring-hv-line bg-hv-widget-panel p-4 grid gap-4 grid-cols-1 md:grid-cols-[1fr_1fr_2fr]">
          <Field label="Reader port (Index)" hint="The physical reader port on the controller, e.g. 1">
            <Input id="rf-port" type="number" min={0} max={64} value={port} invalid={!portOk} onChange={e => setPort(Number(e.target.value))} mono />
          </Field>
          <Field label="Reader on that port (Reader.Index)" hint="0 = the first reader on the port">
            <Input id="rf-reader" type="number" min={0} max={126} value={reader} invalid={!readerOk} onChange={e => setReader(Number(e.target.value))} mono />
          </Field>
          <Field label="What you're sending">
            <div className="flex flex-col gap-2">
              <Segmented value={fileType} onChange={setFileType} items={[{ id: 'firmware', label: 'Reader firmware' }, { id: 'config', label: 'Reader config file' }]} />
              <span className="text-[11px] text-hv-text-3">{fileType === 'firmware' ? 'Firmware needs the reader port at 38400 baud or faster.' : 'Config files also work at 9600 baud.'}</span>
            </div>
          </Field>
        </section>

        {/* What */}
        <section className="rounded-hv-sm ring-1 ring-inset ring-hv-line bg-hv-widget-panel p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-semibold text-hv-text-2">File</span>
            <Segmented value={source} onChange={setSource} items={[{ id: 'library', label: <span className="inline-flex items-center gap-1"><Library size={12} />Aether firmware library</span> }, { id: 'upload', label: <span className="inline-flex items-center gap-1"><Upload size={12} />From this PC</span> }]} />
          </div>
          {source === 'library' ? (
            libErr ? <div className="text-xs text-hv-error-fg">{libErr}</div>
              : !library ? <div className="text-xs text-hv-text-3 flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" />Loading the library…</div>
                : !library.length ? <div className="text-xs text-hv-text-3">The library is empty. Add files in Readers › OSDP › Firmware, or switch to "From this PC".</div>
                  : (
                    <div className="overflow-x-auto rounded-hv-xs ring-1 ring-inset ring-hv-line">
                      <table className="w-full text-xs">
                        <thead><tr className="text-left text-hv-text-3 bg-hv-box">
                          <th className="w-8" /><th className="px-2 py-1.5 font-semibold">File</th><th className="px-2 py-1.5 font-semibold">Model</th><th className="px-2 py-1.5 font-semibold">Version</th><th className="px-2 py-1.5 font-semibold text-right">Size</th><th className="px-2 py-1.5 font-semibold">Notes</th>
                        </tr></thead>
                        <tbody>{library.map(l => (
                          <tr key={l.id} onClick={() => setLibraryId(l.id)} className={cx('border-t border-hv-line cursor-pointer', l.id === libraryId ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')}>
                            <td className="pl-2"><input type="radio" name="rf-lib" checked={l.id === libraryId} onChange={() => setLibraryId(l.id)} className="accent-[rgb(var(--hv-brand))]" /></td>
                            <td className="px-2 py-1.5 font-mono text-hv-text whitespace-nowrap">{l.filename}</td>
                            <td className="px-2 py-1.5 text-hv-text-2">{l.model || '—'}</td>
                            <td className="px-2 py-1.5 text-hv-text-2 whitespace-nowrap">{l.version || '—'}</td>
                            <td className="px-2 py-1.5 text-hv-text-2 text-right tabular-nums whitespace-nowrap">{fmtBytes(l.sizeBytes)}</td>
                            <td className="px-2 py-1.5 text-hv-text-3">{l.notes || ''}</td>
                          </tr>))}
                        </tbody>
                      </table>
                    </div>
                  )
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <input ref={fileRef} id="rf-file" type="file" accept=".bin,.cfg,.dat,application/octet-stream" className="hidden" onChange={e => { setFile(e.target.files?.[0] || null); e.target.value = ''; }} />
              <Button icon={<Upload size={14} />} onClick={() => fileRef.current?.click()}>Choose file…</Button>
              {file ? <span className="text-xs text-hv-text-2"><span className="font-mono text-hv-text">{file.name}</span> · {fmtBytes(file.size)}</span> : <span className="text-xs text-hv-text-3">No file chosen</span>}
            </div>
          )}
          {chosen && fileType === 'firmware' && (
            <div className="text-[11px] text-hv-text-3 flex items-center gap-1.5"><Clock size={12} />At 9600 baud a file this size took about {fmtDur(est9600)} on this Pi (1 Oct flash). Expect it to be several times faster at 38400.</div>
          )}
        </section>

        {/* How */}
        <section className="rounded-hv-sm ring-1 ring-inset ring-hv-line bg-hv-widget-panel p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-semibold text-hv-text-2">SUNAPI call</span>
            <Segmented value={call} onChange={c => { setCall(c); if (c === 'custom' && !customQuery) setCustomQuery(defaultQuery(port, reader)); }} items={[{ id: 'install', label: 'Temporary (action=install)' }, { id: 'custom', label: 'Edit the query' }]} />
          </div>
          {call === 'custom' && (
            <div className="flex flex-col gap-1.5">
              <Input id="rf-query" mono value={customQuery} onChange={e => setCustomQuery(e.target.value)} />
              <div className="flex gap-2 flex-wrap">
                <Button size="sm" tone="ghost" onClick={() => setCustomQuery(defaultQuery(port, reader))}>Reset to temporary call</Button>
                <Button size="sm" tone="ghost" onClick={() => setCustomQuery(OFFICIAL(port, reader))} title="Defined, not implemented on the controller yet">Official call (when available)</Button>
              </div>
            </div>
          )}
          <div className="grid gap-1 text-xs">
            <div className="flex items-start gap-2 min-w-0"><span className="text-hv-text-3 w-16 shrink-0">POST</span><span className="font-mono text-hv-text break-all">{url}</span></div>
            <div className="flex items-start gap-2 min-w-0"><span className="text-hv-text-3 w-16 shrink-0">Body</span><span className="text-hv-text-2">{chosen ? `${chosen.name} · ${fmtBytes(chosen.bytes)} · application/octet-stream` : 'the file'}</span></div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Button size="sm" tone="ghost" icon={<Copy size={12} />} onClick={() => copyText(curl)} title="Same request as curl (password left out; curl asks for it)">Copy as curl</Button>
            <label className="inline-flex items-center gap-2 text-xs text-hv-text-2 whitespace-nowrap"><span>Give up after</span>
              <span className="w-16"><Input id="rf-timeout" type="number" min={1} max={90} value={timeoutMin} onChange={e => setTimeoutMin(Number(e.target.value) || 30)} /></span><span>min</span></label>
          </div>
        </section>

        {/* Send */}
        <section className="flex flex-col gap-3">
          {fileType === 'firmware' && (
            <label className="flex items-start gap-2 text-sm text-hv-text cursor-pointer">
              <input id="rf-baud" type="checkbox" checked={baudOk} onChange={e => setBaudOk(e.target.checked)} className="mt-1 accent-[rgb(var(--hv-brand))]" />
              <span>The reader and controller port {port} are set to <b>38400 baud or faster</b>. <span className="text-hv-text-3">Firmware transfer is refused below that; config files are fine at 9600.</span></span>
            </label>
          )}
          {!confirming ? (
            <div className="flex items-center gap-3 flex-wrap">
              <Button tone="primary" icon={running ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} disabled={!ready} onClick={() => setConfirming(true)}>
                {running ? 'Transfer running…' : fileType === 'firmware' ? 'Send firmware to reader' : 'Send config to reader'}
              </Button>
              {!chosen && <span className="text-xs text-hv-text-3">Choose a file first.</span>}
            </div>
          ) : (
            <div className="rounded-hv-sm px-4 py-3 bg-hv-warning-tint text-hv-warning-text ring-1 ring-inset ring-hv-warning/40 flex flex-col gap-2">
              <div className="text-sm">
                Send <b className="font-mono">{chosen?.name}</b> ({fmtBytes(chosen?.bytes)}) to <b>reader {reader} on port {port}</b> of <b>{device.name}</b>?
                {fileType === 'firmware' ? ' The reader will rewrite its firmware and reboot. Don’t power it off or unplug it while this runs.' : ' The reader will apply the new configuration.'}
                {' '}The controller doesn’t report progress yet, so this page shows elapsed time only.
              </div>
              <label className="inline-flex items-center gap-2 text-sm"><input id="rf-understand" type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)} className="accent-[rgb(var(--hv-brand))]" />I understand</label>
              <div className="flex gap-2">
                <Button tone="primary" disabled={!understood} onClick={send}>Yes, send</Button>
                <Button tone="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            </div>
          )}
          {err && <div className="text-xs rounded-hv-xs px-3 py-2 bg-hv-error-tint text-hv-error-text ring-1 ring-inset ring-hv-error/40 flex items-center gap-2"><AlertTriangle size={14} />{err}</div>}
        </section>

        {/* Status */}
        {job && (
          <section className={cx('rounded-hv-sm p-4 ring-1 ring-inset flex flex-col gap-3',
            job.state === 'running' ? 'bg-hv-info-tint ring-hv-info/40' : job.state === 'done' ? 'bg-hv-success-tint ring-hv-success/40' : 'bg-hv-error-tint ring-hv-error/40')}>
            <div className="flex items-start gap-2">
              {job.state === 'running' ? <Loader2 size={18} className="animate-spin text-hv-info-fg mt-0.5" /> : job.state === 'done' ? <CheckCircle2 size={18} className="text-hv-success-fg mt-0.5" /> : <XCircle size={18} className="text-hv-error-fg mt-0.5" />}
              <div className="min-w-0">
                <div className="text-sm font-semibold text-hv-text">
                  {job.state === 'running' ? (job.phase === 'login' ? 'Logging in…' : job.phase === 'uploading' ? 'Uploading the file to the controller…' : 'File delivered to the controller, waiting for its answer…')
                    : job.state === 'done' ? 'Controller accepted the file' : job.state === 'refused' ? 'Controller refused the file' : 'Transfer failed'}
                </div>
                <div className="text-xs text-hv-text-2">
                  <span className="font-mono">{job.file.name}</span> · {fmtBytes(job.file.bytes)} · port {job.portIndex} reader {job.readerIndex} · started {fmtTime(job.startedAt)} · elapsed <span className="tabular-nums">{fmtDur(elapsed)}</span>
                  {job.sentAt && <> · waiting <span className="tabular-nums">{fmtDur(waiting)}</span></>}
                </div>
                {job.error && <div className="text-xs text-hv-error-fg mt-1">{job.error}</div>}
                {job.state === 'running' && job.phase === 'waiting' && (
                  <div className="text-[11px] text-hv-text-3 mt-1">The controller is passing the file to the reader now. To watch it, open Readers › OSDP Trace with a listen-only tap on that reader’s RS-485 pair. Don’t poll the bus from Aether while the controller is sending.</div>
                )}
                {job.state === 'done' && job.fileType === 'firmware' && (
                  <div className="text-[11px] text-hv-text-2 mt-1">An answer from the controller isn’t proof the reader finished. Confirm the reader comes back online and check its firmware version.</div>
                )}
              </div>
            </div>
            {job.result && (
              <div className="rounded-hv-xs bg-hv-surface ring-1 ring-inset ring-hv-line overflow-hidden">
                <ResponseView r={{ ...job.result, url: job.url, label: 'accesscontrol.cgi › credentialreader · install' }} fileBase="reader-file-response" />
              </div>
            )}
          </section>
        )}

        {past.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-hv-text-2 flex items-center gap-1.5"><FileCog size={13} />Earlier transfers to this controller</span>
            <div className="overflow-x-auto rounded-hv-xs ring-1 ring-inset ring-hv-line">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-hv-text-3 bg-hv-box"><th className="px-2 py-1.5 font-semibold">When</th><th className="px-2 py-1.5 font-semibold">File · port · reader</th><th className="px-2 py-1.5 font-semibold">Result</th><th className="px-2 py-1.5 font-semibold text-right">Took</th></tr></thead>
                <tbody>{past.map((h, i) => (
                  <tr key={i} className="border-t border-hv-line text-hv-text-2">
                    <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">{fmtTime(h.at)}</td>
                    <td className="px-2 py-1.5">{(h as HistoryEntry & { file?: string }).file || h.query}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{h.error ? <Badge tone="error">{h.error.slice(0, 60)}</Badge> : <Badge tone={h.status === 200 ? 'success' : 'error'}>HTTP {h.status}</Badge>}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{h.ms != null ? fmtDur(h.ms) : '—'}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
