import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { canonicalModel } from '@shared/catalog';
import type { ChatEngine } from '@shared/contracts/threed';
import type { ProviderId } from '@shared/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { imageUrl } from '@/components/MessageView';
import { ModelAnimations, ModelTextures } from '@/components/ModelAssets';
import { ModelButton, defaultModel } from '@/components/ModelPicker';
import { ModelViewer3D } from '@/components/ModelViewer3D';
import { ModelWorkfiles } from '@/components/ModelWorkfiles';
import { ThreeDTools } from '@/components/ThreeDTools';
import { cx } from '@/components/ui';

type Detail = Awaited<ReturnType<typeof hub.threedGet>>;
type Project = Awaited<ReturnType<typeof hub.threedList>>[number];
type StudioTab = 'viewport' | 'workfiles' | 'textures' | 'animations' | 'history';

const STUDIO_TABS: { id: StudioTab; label: string; icon: string }[] = [
  { id: 'viewport', label: 'Viewport', icon: 'lucide:cuboid' },
  { id: 'workfiles', label: 'Dateien', icon: 'lucide:files' },
  { id: 'textures', label: 'Texturen', icon: 'lucide:palette' },
  { id: 'animations', label: 'Animationen', icon: 'lucide:clapperboard' },
  { id: 'history', label: 'Verlauf', icon: 'lucide:history' },
];

export function ThreeDPage() {
  const location = useLocation();
  const statuses = useHub((state) => state.statuses);
  const settings = useHub((state) => state.data.settings);
  const initialProjectId = (location.state as { projectId?: string } | null)?.projectId;

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<StudioTab>('viewport');
  const [live, setLive] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState<ProviderId>(settings.defaultProvider);
  const [model, setModel] = useState<string | undefined>(() => settings.providerDefaults[settings.defaultProvider]?.model);
  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');

  const resolvedModel = model ?? defaultModel(provider, statuses[provider]);

  const loadProjects = async () => {
    const list = await hub.threedList();
    setProjects(list);
    if (!projectId && list.length > 0) {
      setProjectId(list[0].id);
    }
  };

  useEffect(() => {
    void loadProjects().catch((reason: unknown) => setError(String(reason)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!projectId) {
      setDetail(null);
      setFrame(null);
      setLive(false);
      return;
    }

    let alive = true;
    setError('');
    setFrame(null);

    const refreshDetail = () => {
      void hub.threedGet(projectId)
        .then((value) => { if (alive) { setDetail(value); } })
        .catch((reason: unknown) => { if (alive) { setError(String(reason)); } });
    };

    refreshDetail();
    void hub.threedViewerStatus(projectId)
      .then((value) => { if (alive) { setLive(value); } })
      .catch(() => {});

    const offFrame = hub.onThreedFrame((event) => {
      if (!alive || event.projectId !== projectId) {
        return;
      }
      if (event.error) {
        setError(event.error);
      }
      if (event.jpeg) {
        setFrame(`data:image/jpeg;base64,${event.jpeg}`);
      }
    });

    const offEvent = hub.onThreedEvent((envelope) => {
      if (!alive || envelope.projectId !== projectId) {
        return;
      }
      const event = envelope.event;
      if (event.type === 'log') {
        setStatusText(event.text);
        return;
      }
      if (event.type === 'iteration') {
        setStatusText(`${t('Iteration')} ${event.n} …`);
        return;
      }
      if (event.type === 'render') {
        refreshDetail();
        return;
      }
      if (event.type === 'done') {
        setRunning(false);
        setStatusText(event.reason || (event.ok ? t('Fertig') : t('Abgebrochen')));
        refreshDetail();
        void loadProjects();
      }
    });

    return () => {
      alive = false;
      offFrame();
      offEvent();
      void hub.threedViewerClose(projectId);
    };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runAction = async (operation: () => Promise<unknown>) => {
    setError('');
    try {
      await operation();
    } catch (reason) {
      setError((reason as Error).message || String(reason));
    }
  };

  const createProject = () => runAction(async () => {
    const created = await hub.threedCreate(t('Neues 3D-Projekt'));
    await loadProjects();
    setProjectId(created.id);
    setTab('viewport');
  });

  const deleteProject = (id: string) => runAction(async () => {
    await hub.threedDelete(id);
    const list = await hub.threedList();
    setProjects(list);
    if (projectId === id) {
      setProjectId(list[0]?.id ?? '');
    }
  });

  const toggleLive = () => runAction(async () => {
    if (!projectId) {
      return;
    }
    if (live) {
      await hub.threedViewerClose(projectId);
      setLive(false);
      setFrame(null);
      return;
    }
    await hub.threedViewerOpen(projectId);
    setLive(true);
  });

  const restoreVersion = (file: string) => runAction(async () => {
    if (!projectId) {
      return;
    }
    await hub.threedRestore(projectId, file);
    setDetail(await hub.threedGet(projectId));
    if (live) {
      await hub.threedViewerOpen(projectId);
    }
  });

  const startGeneration = () => runAction(async () => {
    const goal = prompt.trim();
    if (!goal || running) {
      return;
    }
    let targetId = projectId;
    if (!targetId) {
      const created = await hub.threedCreate(goal.slice(0, 36));
      targetId = created.id;
      setProjectId(targetId);
      await loadProjects();
    }
    setRunning(true);
    setStatusText(t('Starte 3D-Generierung …'));
    const defaults = settings.providerDefaults[provider] ?? {};
    const engine: ChatEngine = {
      type: 'provider',
      provider,
      options: { ...defaults, model: resolvedModel },
    };
    const started = await hub.threedRun(targetId, goal, engine, 6);
    if (!started) {
      setRunning(false);
      setStatusText('');
      return;
    }
    setPrompt('');
  });

  const stopGeneration = () => runAction(async () => {
    if (!projectId) {
      return;
    }
    await hub.threedCancel(projectId);
    setRunning(false);
    setStatusText(t('Abgebrochen'));
  });

  const still = detail?.renders.filter((path) => path.endsWith('-iso.png')).at(-1);

  return (
    <div className="flex h-full min-h-0 bg-bg">
      <aside className="flex w-60 shrink-0 flex-col border-r border-edge bg-surface/60">
        <div className="flex items-center justify-between border-b border-edge px-3 py-2.5">
          <div className="flex items-center gap-2 text-[12.5px] font-semibold text-fg">
            <Icon name="lucide:cuboid" size={15} className="text-accent" />
            <span>3D Studio</span>
          </div>
          <button className="btn btn-primary !px-2.5 !py-1 text-[11.5px]" onClick={() => void createProject()}>
            <Icon name="lucide:plus" size={13} />
            <span>{t('Neu')}</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {projects.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-subtle">
              {t('Noch keine 3D-Projekte.')}
            </p>
          )}
          {projects.map((project) => {
            const selected = project.id === projectId;
            return (
              <div
                key={project.id}
                className={cx(
                  'group flex items-center gap-2 rounded-lumen-sm px-2.5 py-2 transition-colors',
                  selected ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                )}
              >
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setProjectId(project.id)}
                >
                  <span className="block truncate text-[12.5px] font-medium">{project.name}</span>
                  <span className="block text-[10.5px] text-subtle">
                    {new Date(project.updatedAt).toLocaleDateString()}
                  </span>
                </button>
                <button
                  className="icon-btn hidden !size-6 group-hover:grid"
                  title={t('Projekt löschen')}
                  onClick={() => void deleteProject(project.id)}
                >
                  <Icon name="lucide:trash-2" size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="border-t border-edge p-2">
          <button
            className="flex w-full items-center justify-between rounded-lumen-sm px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
            onClick={() => setToolsOpen((value) => !value)}
          >
            <span className="flex items-center gap-2">
              <Icon name="lucide:wrench" size={13} />
              <span>{t('Blockbench & Blender')}</span>
            </span>
            <Icon name={toolsOpen ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={13} />
          </button>
          {toolsOpen && (
            <div className="mt-2 max-h-60 overflow-y-auto px-1">
              <ThreeDTools />
            </div>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-surface/40 px-4 py-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate text-[13.5px] font-semibold text-fg">
              {detail?.model.name ?? t('Kein Projekt ausgewählt')}
            </span>
            {detail && (
              <span className="rounded-full border border-edge bg-surface px-2 py-0.5 text-[11px] text-subtle">
                {detail.summary.cubes} {t('Würfel')} · {detail.model.animations?.length ?? 0} {t('Animationen')}
              </span>
            )}
          </div>
          <div className="flex-1" />
          {detail && (
            <>
              <div className="flex items-center gap-0.5 rounded-full border border-edge bg-surface/80 p-0.5">
                {STUDIO_TABS.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setTab(item.id)}
                    className={cx(
                      'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                      tab === item.id ? 'bg-overlay text-fg shadow-xs' : 'text-subtle hover:text-muted',
                    )}
                  >
                    <Icon name={item.icon} size={12} />
                    <span>{t(item.label)}</span>
                  </button>
                ))}
              </div>
              <button className={cx('btn !py-1 text-[11.5px]', live && 'border-accent text-accent')} onClick={() => void toggleLive()}>
                <Icon name="lucide:radio" size={12} />
                <span>{live ? t('Live an') : t('Live')}</span>
              </button>
              <button className="btn !py-1 text-[11.5px]" onClick={() => void runAction(() => hub.threedOpenWindow(projectId))}>
                <Icon name="lucide:cuboid" size={12} />
                <span>Blockbench</span>
              </button>
              <button className="btn !py-1 text-[11.5px]" onClick={() => void runAction(() => hub.threedOpenBlender(projectId))}>
                <Icon name="lucide:box" size={12} />
                <span>Blender</span>
              </button>
              {detail.exportFile && (
                <button className="btn !py-1 text-[11.5px]" onClick={() => void runAction(() => hub.revealPath(detail.exportFile!))}>
                  <Icon name="lucide:folder-open" size={12} />
                  <span>GLB</span>
                </button>
              )}
            </>
          )}
        </div>

        {error && (
          <div role="alert" className="mx-4 mt-3 flex items-center gap-2 rounded-lumen border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-bad">
            <Icon name="lucide:triangle-alert" size={14} />
            <span className="flex-1">{t(error)}</span>
            <button className="icon-btn !size-5" onClick={() => setError('')}><Icon name="lucide:x" size={12} /></button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!detail ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-4 grid size-14 place-items-center rounded-2xl border border-edge bg-surface text-accent">
                <Icon name="lucide:cuboid" size={26} />
              </div>
              <h1 className="mb-1.5 text-[20px] font-semibold tracking-tight text-fg">3D Studio</h1>
              <p className="mb-5 max-w-md text-[13px] text-muted">
                {t('Erstelle, betrachte und überarbeite 3D-Modelle, Texturen und Animationen direkt im eigenen 3D-Arbeitsbereich.')}
              </p>
              <button className="btn btn-primary !rounded-full !px-4" onClick={() => void createProject()}>
                <Icon name="lucide:plus" size={14} />
                <span>{t('Neues 3D-Projekt erstellen')}</span>
              </button>
            </div>
          ) : tab === 'viewport' ? (
            <div className="mx-auto flex h-full max-w-5xl flex-col justify-center">
              {live && frame ? (
                <img src={frame} alt={detail.model.name} className="max-h-full w-full rounded-lumen-lg border border-edge object-contain" />
              ) : (
                <ModelViewer3D
                  model={detail.model}
                  renderUrl={still ? imageUrl(still) : null}
                  onOpenBlockbench={() => void runAction(() => hub.threedOpenWindow(projectId))}
                />
              )}
            </div>
          ) : tab === 'workfiles' ? (
            <div className="mx-auto max-w-3xl">
              <ModelWorkfiles projectId={projectId} />
            </div>
          ) : tab === 'textures' ? (
            <div className="mx-auto max-w-3xl">
              <ModelTextures model={detail.model} />
            </div>
          ) : tab === 'animations' ? (
            <div className="mx-auto max-w-3xl">
              <ModelAnimations key={projectId} model={detail.model} previews={detail.animationPreviews} />
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-2">
              {!detail.history.length && (
                <p className="py-8 text-center text-[12.5px] text-subtle">{t('Noch keine früheren Stände.')}</p>
              )}
              {detail.history.map((version) => (
                <div key={version.file} className="flex items-center justify-between rounded-lumen border border-edge bg-surface px-3.5 py-2.5 text-[12.5px]">
                  <span className="text-muted">{new Date(version.at).toLocaleString()}</span>
                  <button className="btn !py-1 text-[11.5px]" onClick={() => void restoreVersion(version.file)}>
                    {t('Wiederherstellen')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mx-auto w-full max-w-4xl px-4 pb-4">
          {statusText && (
            <div className="mb-2 flex items-center gap-2 px-1 text-[11.5px] text-muted">
              {running && <Icon name="lucide:loader-circle" size={12} className="spin text-accent" />}
              <span className="truncate">{statusText}</span>
            </div>
          )}
          <div className="composer-shell rounded-[18px]">
            <textarea
              rows={2}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void startGeneration();
                }
              }}
              placeholder={t('Beschreibe das 3D-Modell, Materialien, Texturen oder Animationen …')}
              className="block max-h-[140px] w-full resize-none overflow-x-hidden bg-transparent px-4 pb-1 pt-3 text-[13.5px] leading-relaxed outline-none placeholder:text-subtle"
            />
            <div className="flex items-center gap-2 border-t border-edge/60 px-2.5 py-2">
              <ModelButton
                kind="text"
                provider={provider}
                model={resolvedModel}
                onPick={(nextProvider, nextModel) => {
                  setProvider(nextProvider);
                  setModel(canonicalModel(nextProvider, nextModel));
                }}
              />
              <div className="flex-1" />
              {running ? (
                <button className="btn !rounded-full border-bad/40 bg-bad/15 text-bad hover:bg-bad/25" onClick={() => void stopGeneration()}>
                  <Icon name="lucide:square" size={12} />
                  <span>{t('Stopp')}</span>
                </button>
              ) : (
                <button
                  className="btn btn-primary !rounded-full !px-4"
                  disabled={!prompt.trim()}
                  onClick={() => void startGeneration()}
                >
                  <Icon name="lucide:sparkles" size={13} />
                  <span>{t('Generieren')}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
