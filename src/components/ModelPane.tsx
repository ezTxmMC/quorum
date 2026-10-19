import { t } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { hub } from '@/lib/api';
import { imageUrl } from './MessageView';
import { Icon } from '@/lib/icons';
import { ModelAnimations, ModelTextures } from './ModelAssets';
import { ThreeDTools } from './ThreeDTools';
import { cx } from './ui';

type Detail = Awaited<ReturnType<typeof hub.threedGet>>;
type Project = Awaited<ReturnType<typeof hub.threedList>>[number];

/** The 3D workspace lives beside the conversation; prompts drive every modeling edit. */
export function ModelPane({ projectId, onProject, onClose }: { projectId?: string; onProject: (id: string) => void; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [live, setLive] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'preview' | 'textures' | 'animations' | 'history'>('preview');
  useEffect(() => {
    let alive = true;
    setDetail(null); setFrame(null); setErr(null); setLive(false);
    const refresh = () => {
      void hub.threedList().then((list) => { if (alive) setProjects(list); });
      if (projectId) void hub.threedGet(projectId).then((value) => { if (alive) setDetail(value); }).catch((error: Error) => { if (alive) setErr(error.message); });
    };
    refresh();
    if (projectId) void hub.threedViewerStatus(projectId).then((value) => { if (alive) setLive(value); });
    const offFrame = hub.onThreedFrame((event) => {
      if (!alive || event.projectId !== projectId) return;
      if (event.error) setErr(event.error);
      if (event.jpeg) setFrame(`data:image/jpeg;base64,${event.jpeg}`);
    });
    const offProgress = hub.onThreedEvent((event) => { if (event.projectId === projectId && (event.event.type === 'done' || event.event.type === 'render')) refresh(); });
    return () => { alive = false; offFrame(); offProgress(); if (projectId) void hub.threedViewerClose(projectId); };
  }, [projectId]);
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (error) { setErr((error as Error).message); } };
  const toggle = () => act(async () => {
    if (!projectId) return;
    if (live) { await hub.threedViewerClose(projectId); setLive(false); setFrame(null); }
    else { await hub.threedViewerOpen(projectId); setLive(true); }
  });
  const create = () => act(async () => { const project = await hub.threedCreate(t('Neues Modell')); onProject(project.id); });
  const restore = (file: string) => act(async () => {
    if (!projectId) return;
    await hub.threedRestore(projectId, file);
    setDetail(await hub.threedGet(projectId));
    if (live) await hub.threedViewerOpen(projectId);
  });
  const still = detail?.renders.filter((path) => path.endsWith('-iso.png')).at(-1);
  const shown = frame ?? (still ? imageUrl(still) : null);
  return <aside className="dock-zone dock-right absolute inset-y-0 right-0 z-20 flex w-full shrink-0 sm:w-[420px] sm:max-w-full xl:relative xl:inset-auto xl:max-w-[45%] flex-col border-l border-edge bg-surface">
    <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
      <Icon name="lucide:cuboid" size={15} /><span className="flex-1 font-medium">{t('Modellgenerierung')}</span>
      <button className="icon-btn" title={t('Schließen')} onClick={onClose}><Icon name="lucide:x" /></button>
    </div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <select className="field" aria-label={t('3D-Projekt')} value={projectId ?? ''} onChange={(event) => { if (event.target.value) onProject(event.target.value); }}>
          <option value="">{t('Neues Modell aus dem nächsten Prompt')}</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <button className="icon-btn shrink-0" title={t('Neues Modell')} onClick={() => void create()}><Icon name="lucide:plus" size={15} /></button>
      </div>
      <ThreeDTools />
      {!projectId && <p className="rounded-lumen border border-dashed border-edge p-4 text-[12px] text-subtle">{t('Beschreibe dein Modell im Chat. Weitere Nachrichten überarbeiten dasselbe Projekt.')}</p>}
      {detail && <>
        <div className="text-[12px] text-muted">{detail.model.name} · {detail.summary.cubes} {t('Würfel')} · {detail.model.animations?.length ?? 0} {t('Animationen')}</div>
        <div className="flex flex-wrap gap-1">{(['preview', 'textures', 'animations', 'history'] as const).map((value) => <button key={value} className={cx('rounded-lumen-sm px-2 py-1 text-[12px] hover:bg-hover', tab === value && 'bg-active')} onClick={() => setTab(value)}>
          {t(value === 'preview' ? 'Vorschauen' : value === 'textures' ? 'Texturen' : value === 'animations' ? 'Animationen' : 'Verlauf')}
        </button>)}</div>
        {tab === 'preview' && <>
          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={() => void toggle()}>{live ? t('Live aus') : t('Live an')}</button>
            <button className="btn" onClick={() => void act(() => hub.threedOpenWindow(projectId!))}>{t('In Blockbench öffnen')}</button>
          </div>
          {shown ? <img src={shown} alt={detail.model.name} className="w-full rounded-lumen border border-edge" /> : <p className="text-[12px] text-subtle">{t('Noch keine Vorschau.')}</p>}
        </>}
        {tab === 'textures' && <ModelTextures model={detail.model} />}
        {tab === 'animations' && <ModelAnimations key={projectId} model={detail.model} previews={detail.animationPreviews} />}
        {tab === 'history' && <div className="space-y-2">{!detail.history.length && <p className="text-[12px] text-subtle">{t('Noch keine früheren Stände.')}</p>}{detail.history.map((version) => <div key={version.file} className="flex items-center gap-2 text-[12px]"><span className="flex-1 text-muted">{new Date(version.at).toLocaleString()}</span><button className="btn" onClick={() => void restore(version.file)}>{t('Wiederherstellen')}</button></div>)}</div>}
        {detail.exportFile && <button className="btn" onClick={() => void act(() => hub.revealPath(detail.exportFile!))}><Icon name="lucide:folder-open" size={14} />{t('GLB im Ordner zeigen')}</button>}
      </>}
      {err && <p className="text-[12px] text-bad">{err}</p>}
    </div>
  </aside>;
}
