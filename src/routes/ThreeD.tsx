import { t } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import type { ModelRecord } from '@shared/models';
import type { BbModel, BbSummary } from '@shared/bbmodel';
import type { ProjectInfo } from '../../electron/3d/service';
import type { LoopEvent } from '../../electron/3d/loop';
import type { ChatEngine } from '../../electron/3d/llm';
import { imageUrl } from '@/components/MessageView';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { cx } from '@/components/ui';

type Detail = { model: BbModel; summary: BbSummary; description: string; renders: string[]; history: { file: string; at: number }[] };
type LogLine = { at: number; text: string; kind: 'ok' | 'warn' | 'err' | 'info' };

function fmtEvent(e: LoopEvent | { type: 'log'; text: string }): LogLine | undefined {
  const at = Date.now();
  switch (e.type) {
    case 'iteration': return { at, kind: 'info', text: `Runde ${e.n}` };
    case 'plan': return { at, kind: e.errors.length ? 'warn' : 'info', text: `Plan: ${e.actions} Aktionen${e.errors.length ? ` · ${e.errors.join('; ')}` : ''}` };
    case 'render': return { at, kind: e.ok ? 'ok' : 'err', text: e.ok ? `Vorschau ${e.n} erzeugt` : `Vorschau fehlgeschlagen: ${e.error ?? ''}` };
    case 'done': return { at, kind: e.ok ? 'ok' : 'warn', text: `${e.reason} (${e.iterations} Runden)` };
    case 'log': return { at, kind: 'info', text: e.text };
  }
  return undefined;
}

export function ThreeDPage() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [blender, setBlender] = useState<{ bin?: string; version?: string } | null>(null);
  const [engine, setEngine] = useState('');
  const [goal, setGoal] = useState('');
  const [iters, setIters] = useState('3');
  const [log, setLog] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [viewerErr, setViewerErr] = useState<string | null>(null);

  const reloadList = () => void hub.threedList().then(setProjects);
  const reloadDetail = (id: string) => void hub.threedGet(id).then(setDetail).catch((e: Error) => setErr(e.message));

  useEffect(() => {
    reloadList();
    void hub.models().then((ms) => setModels(ms.filter((m) => m.capabilities.some((c) => ['chat', 'coding', 'reasoning', 'agent'].includes(c)))));
    void hub.threedBlender().then(setBlender);
    return hub.onThreedEvent(({ projectId, event }) => {
      if (projectId !== sel) return;
      const line = fmtEvent(event);
      if (line) setLog((l) => [...l.slice(-200), line]);
      if (event.type === 'done') { setRunning(false); reloadDetail(projectId); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  useEffect(() => { if (sel) { setLog([]); setErr(null); reloadDetail(sel); } }, [sel]);

  // Live-Ansicht: Bildstrom von Blockbench (headless) für das gewählte Projekt.
  useEffect(() => {
    setFrame(null); setViewerErr(null);
    if (!sel) { setLive(false); return; }
    void hub.threedViewerStatus(sel).then(setLive);
    return hub.onThreedFrame((f) => {
      if (f.projectId !== sel) return;
      if (f.error) setViewerErr(f.error);
      if (f.jpeg) setFrame(`data:image/jpeg;base64,${f.jpeg}`);
    });
  }, [sel]);
  const toggleLive = async () => {
    if (!sel) return;
    setViewerErr(null);
    try {
      if (live) { await hub.threedViewerClose(sel); setLive(false); setFrame(null); }
      else { await hub.threedViewerOpen(sel); setLive(true); }
    } catch (e) { setViewerErr((e as Error).message); }
  };
  const openWindow = async () => {
    if (!sel) return;
    setViewerErr(null);
    try { await hub.threedOpenWindow(sel); } catch (e) { setViewerErr((e as Error).message); }
  };

  const create = async () => {
    const p = await hub.threedCreate(t('Neues Modell'));
    reloadList();
    setSel(p.id);
  };
  const remove = async (id: string) => {
    if (!window.confirm(t('Projekt löschen? Dateien im Projektordner gehen verloren.'))) return;
    await hub.threedDelete(id);
    if (sel === id) { setSel(null); setDetail(null); }
    reloadList();
  };
  const run = async () => {
    if (!sel || !engine || !goal.trim()) return;
    const eng: ChatEngine = engine.startsWith('cli:')
      ? { type: 'cli', provider: engine.slice(4) as 'claude' }
      : { type: 'local', modelId: engine.slice(6) };
    setErr(null);
    setRunning(true);
    try {
      await hub.threedRun(sel, goal.trim(), eng, Number(iters) || 3);
    } catch (e) {
      setRunning(false);
      setErr((e as Error).message);
    }
  };
  const restore = async (file: string) => {
    if (!sel) return;
    await hub.threedRestore(sel, file);
    reloadDetail(sel);
  };

  const issues = detail?.summary.issues ?? [];
  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 space-y-2 overflow-y-auto border-r border-edge p-3">
        <button className="btn w-full justify-center" onClick={() => void create()}><Icon name="lucide:plus" size={14} /> {t('Neues Modell')}</button>
        {projects.length === 0 && <div className="px-1 text-[12px] text-subtle">{t('Noch keine 3D-Projekte.')}</div>}
        {projects.map((p) => (
          <div key={p.id} className={cx('group flex items-center gap-2 rounded-lumen border px-2.5 py-2', sel === p.id ? 'border-accent bg-accent/10' : 'border-edge hover:bg-hover')}>
            <button className="min-w-0 flex-1 text-left" onClick={() => setSel(p.id)}>
              <div className="truncate text-[13px]">{p.name}</div>
              <div className="font-mono text-[10.5px] text-subtle">{p.id}</div>
            </button>
            <button className="icon-btn opacity-0 group-hover:opacity-100" title={t('Löschen')} onClick={() => void remove(p.id)}><Icon name="lucide:trash-2" size={13} /></button>
          </div>
        ))}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {!detail && <div className="p-8 text-[12.5px] text-subtle">{t('Projekt auswählen oder neu anlegen.')}</div>}
        {detail && (
          <div className="mx-auto max-w-4xl space-y-5 px-6 py-6">
            <div>
              <h1 className="text-[20px] font-semibold tracking-tight">{detail.model.name}</h1>
              <div className="text-[12px] text-subtle">
                {detail.summary.cubes} {t('Würfel')} · {detail.summary.groups} {t('Gruppen')} · {detail.summary.format}
                {' · '}
                {blender?.bin ? `Blender ${blender.version ?? ''}` : t('Blender nicht gefunden (QUORUM_BLENDER setzen)')}
              </div>
            </div>

            {issues.length > 0 && (
              <div className="space-y-1 rounded-lumen border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px]">
                {issues.map((i, k) => <div key={k} className={i.level === 'error' ? 'text-bad' : 'text-warn'}>{i.level === 'error' ? t('Fehler') : t('Hinweis')}: {i.message}</div>)}
              </div>
            )}

            <section className="space-y-3 rounded-lumen-lg border border-edge bg-surface p-4">
              <h2 className="text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Modellierungsauftrag')}</h2>
              <textarea className="field min-h-20" placeholder={t('Beschreibe das Modell, z. B. ein Stuhl mit vier Beinen')} value={goal} onChange={(e) => setGoal(e.target.value)} />
              <div className="flex flex-wrap items-end gap-3 text-[12px]">
                <label className="flex min-w-56 flex-1 flex-col gap-1"><span className="text-subtle">{t('Modell für den Plan')}</span>
                  <select className="field" value={engine} onChange={(e) => setEngine(e.target.value)}>
                    <option value="">{t('– wählen –')}</option>
                    {models.map((m) => <option key={m.id} value={`local:${m.id}`}>{m.name} ({t('lokal')})</option>)}
                    {['claude', 'codex'].map((p) => <option key={p} value={`cli:${p}`}>{p} ({t('CLI, nur lesend')})</option>)}
                  </select>
                </label>
                <label className="flex w-28 flex-col gap-1"><span className="text-subtle">{t('Runden')}</span><input className="field" value={iters} onChange={(e) => setIters(e.target.value.replace(/\D/g, ''))} /></label>
                {running
                  ? <button className="btn" onClick={() => sel && void hub.threedCancel(sel)}><Icon name="lucide:square" size={14} /> {t('Stopp')}</button>
                  : <button className="btn btn-primary" disabled={!engine || !goal.trim()} onClick={() => void run()}><Icon name="lucide:play" size={14} /> {t('Modellieren')}</button>}
              </div>
              {err && <div className="text-[12px] text-bad">{err}</div>}
              {log.length > 0 && (
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lumen border border-edge bg-hover p-2 font-mono text-[11.5px]">
                  {log.map((l, i) => <li key={i} className={cx(l.kind === 'ok' && 'text-ok', l.kind === 'warn' && 'text-warn', l.kind === 'err' && 'text-bad')}>{l.text}</li>)}
                </ul>
              )}
            </section>

            <section className="space-y-2 rounded-lumen-lg border border-edge bg-surface p-4">
              <div className="flex items-center gap-2">
                <h2 className="flex-1 text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Live-Ansicht · Blockbench')}</h2>
                <button className="btn" onClick={() => void toggleLive()}><Icon name={live ? 'lucide:square' : 'lucide:play'} size={14} /> {live ? t('Live beenden') : t('Live starten')}</button>
                <button className="btn" onClick={() => void openWindow()}><Icon name="lucide:external-link" size={14} /> {t('In Blockbench öffnen')}</button>
              </div>
              {viewerErr && <div className="text-[12px] text-bad">{viewerErr}</div>}
              {frame
                ? <img src={frame} alt="" className="w-full rounded-lumen border border-edge" />
                : <div className="rounded-lumen border border-dashed border-edge p-6 text-center text-[12px] text-subtle">{live ? t('Warte auf die erste Ansicht …') : t('Live-Ansicht startet headless, ohne Fenster auf deinem Bildschirm.')}</div>}
            </section>

            {detail.renders.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Vorschauen')}</h2>
                <div className="grid grid-cols-3 gap-2">
                  {detail.renders.slice(-12).map((p) => <img key={p} src={imageUrl(p)} alt="" className="rounded-lumen border border-edge" />)}
                </div>
              </section>
            )}

            <section className="space-y-2">
              <h2 className="text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Verlauf')}</h2>
              {detail.history.length === 0 && <div className="text-[12px] text-subtle">{t('Noch keine früheren Stände.')}</div>}
              {detail.history.slice(0, 15).map((h) => (
                <div key={h.file} className="flex items-center gap-3 rounded-lumen border border-edge px-3 py-1.5 text-[12px]">
                  <span className="flex-1 text-subtle">{new Date(h.at).toLocaleString('de-DE')}</span>
                  <button className="btn" onClick={() => void restore(h.file)}>{t('Wiederherstellen')}</button>
                </div>
              ))}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
