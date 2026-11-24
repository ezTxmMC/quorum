import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { canonicalModel } from '@shared/catalog';
import type { ChatEngine } from '@shared/contracts/threed';
import type { ProviderId } from '@shared/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { idleRun, useThreeDRuns, type ProjectRun, type RunEntry } from '@/lib/threedRuns';
import { imageUrl } from '@/components/MessageView';
import { ModelAnimations, ModelTextures } from '@/components/ModelAssets';
import { ModelButton, defaultModel } from '@/components/ModelPicker';
import { ModelViewer3D } from '@/components/ModelViewer3D';
import { ModelWorkfiles } from '@/components/ModelWorkfiles';
import { MenuItem, Popover, cx } from '@/components/ui';

type Detail = Awaited<ReturnType<typeof hub.threedGet>>;
type StudioTab = 'viewport' | 'workfiles' | 'textures' | 'animations' | 'history';

const STUDIO_TABS: { id: StudioTab; label: string; icon: string }[] = [
  { id: 'viewport', label: 'Viewport', icon: 'lucide:cuboid' },
  { id: 'workfiles', label: 'Dateien', icon: 'lucide:files' },
  { id: 'textures', label: 'Texturen', icon: 'lucide:palette' },
  { id: 'animations', label: 'Animationen', icon: 'lucide:clapperboard' },
  { id: 'history', label: 'Verlauf', icon: 'lucide:history' },
];

const MAX_ITERATIONS = 6;
const PROJECT_NAME_LENGTH = 48;

/** Projektname aus dem ersten Auftrag: an einer Wortgrenze gekürzt, damit kein halbes Wort in der Titelzeile steht. */
function projectName(goal: string): string {
  const flat = goal.replace(/\s+/g, ' ').trim();
  if (flat.length <= PROJECT_NAME_LENGTH) {
    return flat;
  }
  const cut = flat.slice(0, PROJECT_NAME_LENGTH);
  const space = cut.lastIndexOf(' ');
  return `${space > PROJECT_NAME_LENGTH / 2 ? cut.slice(0, space) : cut}…`;
}

const ENTRY_ICONS: Record<Exclude<RunEntry['kind'], 'prompt'>, { icon: string; tone: string }> = {
  round: { icon: 'lucide:layers', tone: 'text-subtle' },
  step: { icon: 'lucide:dot', tone: 'text-subtle' },
  warning: { icon: 'lucide:triangle-alert', tone: 'text-warn' },
  success: { icon: 'lucide:circle-check', tone: 'text-ok' },
  failure: { icon: 'lucide:circle-x', tone: 'text-bad' },
};

function entryText(entry: RunEntry): string {
  if (!entry.round) {
    return t(entry.text);
  }
  const changes = `${t('Runde')} ${entry.round.n} · ${entry.round.actions} ${t('Änderungen')}`;
  return entry.round.errors > 0 ? `${changes} · ${entry.round.errors} ${t('Fehler')}` : changes;
}

/** Verlauf der Aufträge eines Projekts: der gesendete Text bleibt sichtbar, darunter die Schritte des Laufs. */
function RunLog({ run }: { run: ProjectRun }) {
  const scroller = useRef<HTMLDivElement>(null);
  const last = run.entries.at(-1)?.id;
  useEffect(() => {
    const element = scroller.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [last, run.iteration, run.running]);
  if (!run.entries.length && !run.running) {
    return null;
  }
  const status = run.stopping
    ? t('Wird gestoppt …')
    : run.iteration > 0
      ? `${t('Runde')} ${run.iteration} ${t('von')} ${run.maxIterations || MAX_ITERATIONS} …`
      : t('Starte 3D-Generierung …');
  return (
    <div ref={scroller} className="mb-2 max-h-40 space-y-1 overflow-y-auto px-1" aria-live="polite">
      {run.entries.map((entry) => {
        if (entry.kind === 'prompt') {
          return (
            <div key={entry.id} className="msg-send flex justify-end pb-0.5 pt-1.5">
              <div className="max-w-[85%] select-text whitespace-pre-wrap rounded-2xl rounded-br-md border border-edge-strong/70 bg-surface px-3.5 py-2 text-[13px] leading-relaxed [overflow-wrap:anywhere]">
                {entry.text}
              </div>
            </div>
          );
        }
        const look = ENTRY_ICONS[entry.kind];
        const tone = entry.round && entry.round.errors > 0 ? 'text-warn' : look.tone;
        return (
          <div key={entry.id} className="tick-in flex items-start gap-2 text-[11.5px] text-muted" title={entry.detail}>
            <Icon name={look.icon} size={13} className={cx('mt-px shrink-0', tone)} />
            <span className="min-w-0 flex-1">
              {entryText(entry)}
              {entry.detail && <span className="text-subtle"> – {t(entry.detail)}</span>}
            </span>
          </div>
        );
      })}
      {run.running && (
        <div className="flex items-center gap-2 text-[11.5px] text-muted" role="status">
          <Icon name="lucide:loader-circle" size={13} className="spin shrink-0 text-accent" />
          <span className="text-shimmer">{status}</span>
        </div>
      )}
    </div>
  );
}

export function ThreeDPage() {
  const location = useLocation();
  const statuses = useHub((state) => state.statuses);
  const settings = useHub((state) => state.data.settings);
  const projectId = useHub((state) => state.threeDProjectId);
  const run = useThreeDRuns((state) => (projectId ? state.projects[projectId] : undefined)) ?? idleRun;
  const { setThreeDProjectId, bumpThreeDRevision } = useHub.getState();
  const initialProjectId = (location.state as { projectId?: string } | null)?.projectId;

  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<StudioTab>('viewport');
  const [live, setLive] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState<ProviderId>(settings.defaultProvider);
  const [model, setModel] = useState<string | undefined>(() => settings.providerDefaults[settings.defaultProvider]?.model);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const resolvedModel = model ?? defaultModel(provider, statuses[provider]);
  const busy = run.running || starting;

  useEffect(() => {
    if (initialProjectId) {
      setThreeDProjectId(initialProjectId);
    }
  }, [initialProjectId, setThreeDProjectId]);

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

    void hub.threedViewerStatus(projectId)
      .then((value) => { if (alive) { setLive(value); } })
      .catch(() => {});
    // Nach einem Neuladen der Oberfläche kennt nur der Dienst den laufenden Auftrag.
    void hub.threedRunning(projectId)
      .then((value) => { if (alive) { useThreeDRuns.getState().adopt(projectId, value); } })
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

    return () => {
      alive = false;
      offFrame();
      void hub.threedViewerClose(projectId);
    };
  }, [projectId]);

  // Modell laden: beim Öffnen des Projekts und nach jeder Runde eines Laufs.
  useEffect(() => {
    if (!projectId) {
      return;
    }
    let alive = true;
    void hub.threedGet(projectId)
      .then((value) => { if (alive) { setDetail(value); } })
      .catch((reason: unknown) => { if (alive) { setError(String(reason)); } });
    return () => { alive = false; };
  }, [projectId, run.revision]);

  // Ein beendeter Lauf ändert Würfelzahl und Änderungsdatum: die Projektliste der Seitenleiste nachziehen.
  useEffect(() => {
    if (!run.running) {
      bumpThreeDRevision();
    }
  }, [run.running]);

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
    setThreeDProjectId(created.id);
    bumpThreeDRevision();
    setTab('viewport');
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
    if (!goal || busy) {
      return;
    }
    setStarting(true);
    try {
      let targetId = projectId;
      if (!targetId) {
        const created = await hub.threedCreate(projectName(goal));
        targetId = created.id;
        setThreeDProjectId(targetId);
        bumpThreeDRevision();
      }
      const defaults = settings.providerDefaults[provider] ?? {};
      const engine: ChatEngine = {
        type: 'provider',
        provider,
        options: { ...defaults, model: resolvedModel },
      };
      // Der Auftrag steht sofort im Verlauf; schlägt der Start fehl, bleibt der Text zum Korrigieren im Feld.
      const runs = useThreeDRuns.getState();
      runs.begin(targetId, goal, MAX_ITERATIONS);
      setTab('viewport');
      try {
        await hub.threedRun(targetId, goal, engine, MAX_ITERATIONS);
      } catch (reason) {
        runs.fail(targetId, (reason as Error).message || String(reason));
        throw reason;
      }
      setPrompt('');
    } finally {
      setStarting(false);
    }
  });

  const stopGeneration = () => runAction(async () => {
    if (!projectId) {
      return;
    }
    const runs = useThreeDRuns.getState();
    // Der Lauf endet erst nach der aktuellen Runde; bis zu seiner Abschlussmeldung bleibt er als laufend markiert.
    runs.stopping(projectId);
    if (!(await hub.threedCancel(projectId))) {
      runs.adopt(projectId, false);
    }
  });

  const still = detail?.renders.filter((path) => path.endsWith('-iso.png')).at(-1);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex items-center gap-2 border-b border-edge bg-surface/40 px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="truncate text-[13.5px] font-semibold text-fg" title={detail?.model.name}>
            {detail?.model.name ?? t('Kein Projekt ausgewählt')}
          </span>
          {detail && (
            <span className="shrink-0 rounded-full border border-edge bg-surface px-2 py-0.5 text-[11px] text-subtle">
              {detail.summary.cubes} {t('Würfel')} · {detail.model.animations?.length ?? 0} {t('Animationen')}
            </span>
          )}
        </div>
        {detail && (
          <>
            <div className="flex shrink-0 items-center gap-0.5 rounded-full border border-edge bg-surface/80 p-0.5">
              {STUDIO_TABS.map((item) => (
                <button
                  key={item.id}
                  title={t(item.label)}
                  onClick={() => setTab(item.id)}
                  className={cx(
                    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                    tab === item.id ? 'bg-overlay text-fg shadow-xs' : 'text-subtle hover:text-muted',
                  )}
                >
                  <Icon name={item.icon} size={12} />
                  <span className="hidden lg:inline">{t(item.label)}</span>
                </button>
              ))}
            </div>
            <button
              className={cx('btn shrink-0 !py-1 text-[11.5px]', live && 'border-accent text-accent')}
              title={t('Live-Ansicht aus Blockbench im Viewport zeigen')}
              onClick={() => void toggleLive()}
            >
              <Icon name="lucide:radio" size={12} />
              <span>{live ? t('Live an') : t('Live')}</span>
            </button>
            <Popover
              align="right"
              down
              className="shrink-0"
              trigger={(open, toggle) => (
                <button className={cx('btn !py-1 text-[11.5px]', open && 'bg-active')} onClick={toggle}>
                  <Icon name="lucide:external-link" size={12} />
                  <span>{t('Öffnen in')}</span>
                  <Icon name="lucide:chevron-down" size={11} className="text-subtle" />
                </button>
              )}
            >
              {(close) => (
                <div className="min-w-44 p-1">
                  <MenuItem icon={<Icon name="lucide:cuboid" size={13} className="text-muted" />} onClick={() => { close(); void runAction(() => hub.threedOpenWindow(projectId)); }}>
                    Blockbench
                  </MenuItem>
                  <MenuItem icon={<Icon name="lucide:box" size={13} className="text-muted" />} onClick={() => { close(); void runAction(() => hub.threedOpenBlender(projectId)); }}>
                    Blender
                  </MenuItem>
                  {detail.exportFile && (
                    <MenuItem icon={<Icon name="lucide:folder-open" size={13} className="text-muted" />} onClick={() => { close(); void runAction(() => hub.revealPath(detail.exportFile!)); }}>
                      {t('GLB im Ordner zeigen')}
                    </MenuItem>
                  )}
                </div>
              )}
            </Popover>
          </>
        )}
      </div>

      {error && (
        <div role="alert" className="fade-in mx-4 mt-3 flex items-center gap-2 rounded-lumen border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-bad">
          <Icon name="lucide:triangle-alert" size={14} />
          <span className="flex-1">{t(error)}</span>
          <button className="icon-btn !size-5" onClick={() => setError('')}><Icon name="lucide:x" size={12} /></button>
        </div>
      )}

      <div className={cx('min-h-0 flex-1 px-4 pt-4', tab === 'viewport' || !detail ? 'pb-3' : 'overflow-y-auto pb-4')}>
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
          <div className="mx-auto h-full max-w-5xl xl:max-w-6xl">
            {live && frame ? (
              <div className="flex h-full items-center justify-center">
                <img src={frame} alt={detail.model.name} className="max-h-full max-w-full rounded-lumen-lg border border-edge object-contain" />
              </div>
            ) : (
              <ModelViewer3D
                fill
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
                <button className="btn !py-1 text-[11.5px]" disabled={busy} onClick={() => void restoreVersion(version.file)}>
                  {t('Wiederherstellen')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-5xl px-4 pb-4 xl:max-w-6xl">
        <RunLog run={run} />
        <div className="composer-shell relative rounded-[20px]">
          {run.running && <span aria-hidden="true" className="run-beam" />}
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
            placeholder={run.entries.length > 0
              ? t('Beschreibe die nächste Änderung am Modell …')
              : t('Beschreibe das 3D-Modell, Materialien, Texturen oder Animationen …')}
            className="block max-h-[140px] w-full resize-none overflow-x-hidden bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed outline-none placeholder:text-subtle"
          />
          <div className="flex items-center gap-2 border-t border-edge/60 px-2.5 pb-2 pt-1.5">
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
            {run.running && (
              <button
                className="chip-in grid h-8 w-11 place-items-center rounded-full border border-bad/30 bg-bad/15 text-bad transition-all hover:bg-bad/25 active:scale-95 disabled:opacity-50"
                disabled={run.stopping}
                title={run.stopping ? t('Wird gestoppt …') : t('Stopp')}
                aria-label={t('Stopp')}
                onClick={() => void stopGeneration()}
              >
                <Icon name="lucide:square" size={13} />
              </button>
            )}
            <button
              className="send-btn grid h-8 w-11 place-items-center rounded-full bg-accent text-accent-fg enabled:hover:brightness-110 enabled:active:scale-90 disabled:opacity-35"
              disabled={!prompt.trim() || busy}
              title={run.running ? t('Der nächste Auftrag lässt sich senden, sobald der laufende beendet ist.') : t('Generieren (Enter)')}
              aria-label={t('Generieren')}
              onClick={() => void startGeneration()}
            >
              <Icon name="lucide:arrow-up" size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
