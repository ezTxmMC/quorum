import { t } from '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { CAPABILITY_LABELS, type ChatMessage, type ModelRecord } from '@shared/models';
import { compatibleRuntimes } from '@shared/compat';
import { defaultSelection, expandShards } from '@shared/selection';
import type { LoadedInfo } from '../../electron/runtimes/scheduler';
import type { PyStatus } from '../../electron/runtimes/pyenv';
import type { DownloadState } from '../../electron/models/manager';
import type { HfModelInfo, HfSearchHit } from '../../electron/models/hf';
import type { LocalImageResult } from '../../electron/models/chat';
import { imageUrl } from '@/components/MessageView';
import { hub, uid } from '@/lib/api';
import { useHub } from '@/lib/store';
import { cx } from '@/components/ui';
import { Icon } from '@/lib/icons';

const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
/** Größe lesbar: MB unter 1 GB, sonst GB. */
const size = (b: number) => (b < 1024 ** 3 ? `${Math.round(b / 1024 ** 2)} MB` : `${gb(b)} GB`);
const pct = (a: number, b: number) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);
const TEXT_CAPS = ['chat', 'coding', 'reasoning', 'agent', 'vision'];

function PythonCard() {
  const [st, setSt] = useState<PyStatus | undefined>();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void hub.pyStatus().then(setSt);
    return hub.onPyLog((line) => setLog((l) => [...l.slice(-300), line]));
  }, []);
  const setup = async () => {
    setBusy(true);
    setLog([]);
    const r = await hub.pySetup();
    if (r.status) setSt(r.status);
    else setSt(await hub.pyStatus());
    setBusy(false);
  };
  const ready = !!st?.ready;
  return (
    <section className="rounded-lumen-lg border border-edge bg-surface p-4">
      <div className="flex items-center gap-3">
        <Icon name="lucide:braces" size={18} className="text-muted" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Python <span className="font-normal text-subtle">· Transformers · Diffusers</span></div>
          <div className="truncate font-mono text-[11.5px] text-subtle">
            {st?.torch ? `torch ${st.torch.version}${st.torch.hip ? ` · ROCm ${st.torch.hip}` : ''}${st.torch.device ? ` · ${st.torch.device}` : ''}` : st?.error ?? t('Prüfe Umgebung …')}
          </div>
        </div>
        <span className={cx('rounded-full px-2.5 py-0.5 text-[11.5px]', ready ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn')}>{ready ? t('bereit') : t('einrichten')}</span>
        <button className="btn" disabled={busy} onClick={() => void setup()}>{busy ? t('Richtet ein …') : ready ? t('Aktualisieren') : t('Einrichten')}</button>
      </div>
      {log.length > 0 && <pre className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lumen border border-edge bg-hover p-2 font-mono text-[11px]">{log.join('\n')}</pre>}
    </section>
  );
}

function SearchPanel({ onDownloaded }: { onDownloaded: () => void }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('gguf');
  const [hits, setHits] = useState<HfSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<HfModelInfo | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  const gguf = info ? info.files.some((f) => f.path.endsWith('.gguf')) : false;

  const search = async () => {
    setBusy(true); setErr(null);
    try { setHits(await hub.modelSearch(q, filter || undefined)); } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const open = async (repo: string) => {
    setBusy(true); setErr(null); setPicked([]);
    try {
      const i = await hub.modelInfo(repo);
      setInfo(i);
      const first = i.files.find((f) => f.path.endsWith('.gguf'));
      setPicked(first ? expandShards(i.files, [first.path]) : defaultSelection(i.files));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const toggle = (path: string) => {
    if (gguf) setPicked(expandShards(info?.files ?? [], [path]));
    else setPicked((p) => (p.includes(path) ? p.filter((x) => x !== path) : [...p, path]));
  };
  const download = async () => {
    if (!info || !picked.length) return;
    setErr(null);
    try { await hub.modelDownload(info.repo, picked); onDownloaded(); } catch (e) { setErr((e as Error).message); }
  };
  const total = info ? info.files.filter((f) => picked.includes(f.path)).reduce((s, f) => s + f.size, 0) : 0;
  const shown = info ? (gguf ? info.files.filter((f) => f.path.endsWith('.gguf')) : info.files) : [];

  return (
    <section className="space-y-3">
      <div className="flex gap-2">
        <input className="field flex-1" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} placeholder={t('Hugging Face durchsuchen, z. B. qwen coder')} />
        <select className="field w-44" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="gguf">{t('GGUF (llama.cpp)')}</option>
          <option value="text-generation">{t('Sprachmodelle (Transformers)')}</option>
          <option value="text-to-image">{t('Bildgenerierung (Diffusers)')}</option>
          <option value="">{t('Alle Modelle')}</option>
        </select>
        <button className="btn" onClick={() => void search()} disabled={busy}>{t('Suchen')}</button>
      </div>
      {err && <div className="rounded-lumen border border-bad/40 bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{t(err)}</div>}
      <div className="grid grid-cols-2 gap-3">
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {hits.map((h) => (
            <li key={h.repo}>
              <button onClick={() => void open(h.repo)} className={cx('w-full rounded-lumen border border-edge px-3 py-2 text-left hover:bg-hover', info?.repo === h.repo && 'border-accent')}>
                <div className="truncate font-mono text-[12.5px]">{h.repo}</div>
                <div className="text-[11.5px] text-subtle">{h.pipelineTag ?? '–'} · {h.downloads.toLocaleString('de-DE')} ↓ {h.license ? `· ${h.license}` : ''}</div>
              </button>
            </li>
          ))}
        </ul>
        <div className="rounded-lumen border border-edge p-3">
          {!info && <div className="text-[12.5px] text-subtle">{t('Repo auswählen, um Dateien und Lizenz zu sehen.')}</div>}
          {info && (
            <div className="space-y-2">
              <div className="font-mono text-[12.5px]">{info.repo}</div>
              <div className="text-[11.5px] text-subtle">{info.pipelineTag ?? '–'} · {info.license ?? t('Lizenz unbekannt')}</div>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {shown.map((f) => (
                  <label key={f.path} className="flex cursor-pointer items-center gap-2 text-[12px]">
                    <input type={gguf ? 'radio' : 'checkbox'} name="pick" checked={picked.includes(f.path)} onChange={() => toggle(f.path)} />
                    <span className="flex-1 truncate font-mono">{f.path}</span>
                    <span className="text-subtle">{size(f.size)}</span>
                  </label>
                ))}
              </div>
              {!gguf && <div className="text-[11.5px] text-subtle">{t('Vorauswahl ohne alternative Formate (.bin, .onnx) und ohne doppelte fp32-Gewichte.')}</div>}
              <button className="btn" disabled={!picked.length} onClick={() => void download()}>
                <Icon name="lucide:download" size={14} /> {t('Herunterladen')} {picked.length ? `(${picked.length} · ${size(total)})` : ''}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Downloads({ list, onChanged }: { list: DownloadState[]; onChanged: () => void }) {
  if (!list.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Downloads')}</h2>
      {list.map((d) => {
        const p = pct(d.received, d.total);
        return (
          <div key={d.id} className="rounded-lumen-lg border border-edge bg-surface p-3">
            <div className="mb-2 flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{d.repo}</div>
              <span className="text-[11.5px] text-subtle">{d.status === 'running' ? `${gb(d.received)} / ${gb(d.total)} GB` : d.status === 'paused' ? t('pausiert') : d.status === 'error' ? d.error : t('fertig')}</span>
              {d.status === 'running' && <button className="icon-btn" title={t('Pausieren')} onClick={() => void hub.modelPause(d.id).then(onChanged)}><Icon name="lucide:pause" size={14} /></button>}
              {d.status !== 'done' && <button className="icon-btn" title={t('Abbrechen')} onClick={() => void hub.modelCancel(d.id).then(onChanged)}><Icon name="lucide:x" size={14} /></button>}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-hover"><div className="h-full bg-accent transition-[width]" style={{ width: `${p}%` }} /></div>
          </div>
        );
      })}
    </section>
  );
}

function ImageBox({ m }: { m: ModelRecord }) {
  const [prompt, setPrompt] = useState('');
  const [steps, setSteps] = useState('4');
  const [result, setResult] = useState<LocalImageResult | null>(null);
  const [running, setRunning] = useState(false);
  const generate = async () => {
    setRunning(true);
    setResult(null);
    const r = await hub.modelImage(uid(), m.id, { prompt, steps: Number(steps) || 4, guidance: 0, width: 512, height: 512, seed: Math.floor(Math.random() * 2 ** 31) });
    setResult(r);
    setRunning(false);
  };
  return (
    <div className="mt-3 space-y-2 border-t border-edge pt-3">
      <textarea className="field min-h-16 w-full" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('Bildbeschreibung …')} />
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px]"><span className="text-subtle">{t('Schritte')}</span><input className="field w-24" value={steps} onChange={(e) => setSteps(e.target.value.replace(/\D/g, ''))} /></label>
        <button className="btn" disabled={!prompt.trim() || running} onClick={() => void generate()}>
          <Icon name="lucide:image" size={14} /> {running ? t('Erzeugt …') : t('Bild erzeugen')}
        </button>
      </div>
      {result?.error && <div className="whitespace-pre-wrap text-[12px] text-bad">{t(result.error)}</div>}
      {result?.path && <img src={imageUrl(result.path)} alt={prompt} className="max-h-96 rounded-lumen border border-edge" />}
    </div>
  );
}

function ModelCard({ m, loaded, onChanged }: { m: ModelRecord; loaded?: LoadedInfo; onChanged: () => void }) {
  const [gpuLayers, setGpuLayers] = useState(m.load?.gpuLayers?.toString() ?? '');
  const [ctx, setCtx] = useState(m.load?.contextSize?.toString() ?? '');
  const [trust, setTrust] = useState(!!m.load?.trustRemoteCode);
  const [msg, setMsg] = useState('');
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const compat = compatibleRuntimes({ source: m.source, format: m.format, architecture: m.architecture, capabilities: m.capabilities, needsRemoteCode: m.needsRemoteCode });
  const best = compat[0];
  const textCapable = m.capabilities.some((c) => TEXT_CAPS.includes(c));
  const imageCapable = m.capabilities.includes('text-to-image');

  const act = async (fn: () => Promise<unknown>) => {
    setMsg('');
    try { await fn(); } catch (e) { setMsg((e as Error).message); }
    onChanged();
  };
  const saveConfig = () => void act(() => hub.modelConfig(m.id, {
    ...m.load,
    gpuLayers: gpuLayers === '' ? undefined : Number(gpuLayers),
    contextSize: ctx === '' ? undefined : Number(ctx),
    trustRemoteCode: trust || undefined,
  }));
  const chat = () => {
    const runId = uid();
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    setAnswer(''); setRunning(runId);
    const off = hub.onModelChat((e) => {
      if (e.runId !== runId) return;
      if (e.event.type === 'text' && e.event.delta) setAnswer((a) => a + e.event.delta);
      if (e.event.type === 'done') { setRunning(null); if (!e.event.ok && e.event.error) setMsg(e.event.error); off(); }
    });
    void hub.modelChat(runId, m.id, messages).catch((err: Error) => { setRunning(null); setMsg(err.message); off(); });
  };

  return (
    <article className="rounded-lumen-lg border border-edge bg-surface p-4">
      <div className="flex items-start gap-3">
        <Icon name="lucide:box" size={18} className="mt-0.5 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{m.name}</div>
          <div className="truncate font-mono text-[11.5px] text-subtle">{m.repo ?? m.path}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
            <span className="rounded-full bg-hover px-2 py-0.5">{m.format}</span>
            {m.quantization && <span className="rounded-full bg-hover px-2 py-0.5">{m.quantization}</span>}
            <span className="rounded-full bg-hover px-2 py-0.5">{size(m.sizeBytes)}</span>
            {m.capabilities.map((c) => <span key={c} className="rounded-full bg-accent/15 px-2 py-0.5 text-accent">{t(CAPABILITY_LABELS[c])}</span>)}
            <span className={cx('rounded-full px-2 py-0.5', best?.level === 'likely' ? 'bg-ok/15 text-ok' : best ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad')}>
              {best ? `${best.runtime} · ${t(best.reason)}` : t('Keine Runtime')}
            </span>
          </div>
        </div>
        {loaded ? <span className="rounded-full bg-ok/15 px-2.5 py-0.5 text-[11.5px] text-ok">{t('geladen')} · {loaded.runtime}{loaded.gpuLayers !== undefined ? ` · ${loaded.gpuLayers} GPU-Schichten` : ''}</span> : null}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2 text-[12px]">
        {m.format === 'gguf' && <>
          <label className="flex flex-col gap-1"><span className="text-subtle">{t('GPU-Schichten (leer = auto)')}</span><input className="field w-40" value={gpuLayers} onChange={(e) => setGpuLayers(e.target.value.replace(/\D/g, ''))} /></label>
          <label className="flex flex-col gap-1"><span className="text-subtle">{t('Kontext (leer = Modell)')}</span><input className="field w-40" value={ctx} onChange={(e) => setCtx(e.target.value.replace(/\D/g, ''))} /></label>
        </>}
        {best?.level === 'requires-trust' && (
          <label className="flex max-w-xs cursor-pointer items-start gap-2 rounded-lumen border border-warn/40 bg-warn/10 px-2.5 py-1.5">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} className="mt-0.5" />
            <span className="text-warn">{t('Eigenen Modellcode ausführen (trust_remote_code). Nur bei vertrauenswürdigen Quellen aktivieren.')}</span>
          </label>
        )}
        <button className="btn" onClick={saveConfig}>{t('Speichern')}</button>
        <div className="ml-auto flex gap-2">
          {loaded
            ? <button className="btn" disabled={loaded.inUse > 0} onClick={() => void act(() => hub.modelUnload(m.id))}>{t('Entladen')}</button>
            : <button className="btn" onClick={() => void act(() => hub.modelLoad(m.id, 1))}>{t('Laden')}</button>}
          <button className="icon-btn" title={t('Entfernen')} onClick={() => { if (window.confirm(t('Modell entfernen? Dateien im Quorum-Modellordner werden gelöscht.'))) void act(() => hub.modelRemove(m.id)); }}><Icon name="lucide:trash-2" size={14} /></button>
        </div>
      </div>

      {textCapable && (
        <div className="mt-3 space-y-2 border-t border-edge pt-3">
          <textarea className="field min-h-16 w-full" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('Kurz testen …')} />
          <div className="flex gap-2">
            <button className="btn" disabled={!prompt.trim() || !!running} onClick={chat}>{running ? t('Antwortet …') : t('Senden')}</button>
          </div>
          {answer && <pre className="whitespace-pre-wrap rounded-lumen border border-edge bg-hover p-3 text-[12.5px]">{answer}</pre>}
        </div>
      )}
      {imageCapable && <ImageBox m={m} />}
      {msg && <div className="mt-2 whitespace-pre-wrap text-[12px] text-bad">{t(msg)}</div>}
    </article>
  );
}

export function ModelsPage() {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [loaded, setLoaded] = useState<LoadedInfo[]>([]);
  const [downloads, setDownloads] = useState<DownloadState[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    void useHub.getState().refreshStatus('local', true);
    void hub.models().then(setModels).catch((e: Error) => setErr(e.message));
    void hub.modelLoaded().then(setLoaded);
    void hub.modelDownloads().then(setDownloads);
  }, []);

  useEffect(() => {
    reload();
    const iv = setInterval(() => { void hub.modelLoaded().then(setLoaded); }, 2000);
    const a = hub.onModelDownload((d) => setDownloads((list) => [...list.filter((x) => x.id !== d.id), d]));
    const b = hub.onModelRegistry(() => reload());
    const c = hub.onModelEvent(() => void hub.modelLoaded().then(setLoaded));
    return () => { clearInterval(iv); a(); b(); c(); };
  }, [reload]);

  const importFile = async () => {
    const [p] = await hub.pickFiles('any');
    if (!p) return;
    try { await hub.modelImport(p); reload(); } catch (e) { setErr((e as Error).message); }
  };
  const importFolder = async () => {
    const p = await hub.pickFolder();
    if (!p) return;
    try { await hub.modelImport(p); reload(); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div>
          <h1 className="mb-1 text-[22px] font-semibold tracking-tight">{t('Modelle')}</h1>
          <p className="text-muted">{t('Lokale Modelle von Hugging Face suchen, laden und ausführen. Ressourcen werden live überwacht.')}</p>
        </div>

        <PythonCard />

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="flex-1 text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Suche & Download')}</h2>
          </div>
          <SearchPanel onDownloaded={reload} />
        </section>

        <Downloads list={downloads} onChanged={reload} />

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="flex-1 text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Installiert')} ({models.length})</h2>
            <button className="btn" onClick={() => void importFile()}><Icon name="lucide:file-plus" size={14} /> {t('Datei importieren')}</button>
            <button className="btn" onClick={() => void importFolder()}><Icon name="lucide:folder-plus" size={14} /> {t('Ordner importieren')}</button>
          </div>
          {err && <div className="rounded-lumen border border-bad/40 bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{t(err)}</div>}
          {models.length === 0 && <div className="text-[12.5px] text-subtle">{t('Noch keine Modelle. Suche oben oder importiere eine GGUF-Datei.')}</div>}
          {models.map((m) => (
            <ModelCard key={m.id} m={m} loaded={loaded.find((l) => l.modelId === m.id)} onChanged={reload} />
          ))}
        </section>
      </div>
    </div>
  );
}
