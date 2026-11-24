import { useEffect, useState } from 'react';
import { useBlocker, useLocation, useNavigate } from 'react-router-dom';
import type { ApprovalScope, PlanDefinition, PlanSnapshot } from '@shared/plan/types';
import { initialDefinition } from '@shared/plan/validation';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { WorkspaceEditor } from '@/components/ide/WorkspaceEditor';
import { cx } from '@/components/ui';
import { DefinitionEditor } from './DefinitionEditor';

type WorkspaceTab = 'editor' | 'tasks' | 'definition' | 'history';

const WORKSPACE_TABS: { id: WorkspaceTab; label: string; icon: string }[] = [
  { id: 'editor', label: 'Editor', icon: 'lucide:code-2' },
  { id: 'tasks', label: 'Aufgaben', icon: 'lucide:list-checks' },
  { id: 'definition', label: 'Plan', icon: 'lucide:file-json' },
  { id: 'history', label: 'Revisionen', icon: 'lucide:history' },
];

function definitionOf(snapshot: PlanSnapshot): PlanDefinition {
  const revision = snapshot.revisions[snapshot.revisions.length - 1];
  return {
    objective: revision.objective,
    requirements: revision.requirements,
    constraints: revision.constraints,
    assumptions: revision.assumptions,
    outOfScope: revision.outOfScope,
    phases: revision.phases,
    tasks: revision.tasks,
    modelAssignments: revision.modelAssignments,
  };
}

export function PlanWorkspace() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialRoot = useHub.getState().ideRootPath || useHub.getState().activeCwd || useHub.getState().data.recentProjects[0] || '';
  const root = useHub((state) => state.ideRootPath);
  const ideOpenFile = useHub((state) => state.ideOpenFile);
  const idePlanAction = useHub((state) => state.idePlanAction);
  const { setIdeRootPath } = useHub.getState();

  const [editorDirty, setEditorDirty] = useState(false);
  const [snapshot, setSnapshot] = useState<PlanSnapshot | null>(null);
  const [title, setTitle] = useState('');
  const [definition, setDefinition] = useState(JSON.stringify(initialDefinition('Projektziel beschreiben'), null, 2));
  const [tab, setTab] = useState<WorkspaceTab>('editor');
  const [error, setError] = useState('');
  const [questionText, setQuestionText] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<string>();
  const [scopeOpen, setScopeOpen] = useState(false);
  const [paths, setPaths] = useState('.');
  const [allowWrite, setAllowWrite] = useState(false);
  const [allowShell, setAllowShell] = useState(false);
  const [allowNetwork, setAllowNetwork] = useState(false);
  const [inspectedRevision, setInspectedRevision] = useState('');
  const [previousDefinition, setPreviousDefinition] = useState<string | null>(null);

  useEffect(() => {
    if (!initialRoot || root) {
      return;
    }
    let active = true;
    void hub.ideRoot(initialRoot)
      .then((canonical) => { if (active && !useHub.getState().ideRootPath) { setIdeRootPath(canonical); } })
      .catch(() => { /* Ignore stale or moved initial workspace paths. */ });
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ideOpenFile?.path) {
      return;
    }
    setFile(ideOpenFile.path);
    setTab('editor');
  }, [ideOpenFile]);

  useEffect(() => {
    if (!idePlanAction) {
      return;
    }
    if (idePlanAction.kind === 'new') {
      if (!canLeave()) {
        return;
      }
      setSnapshot(null);
      setEditorDirty(false);
      setTitle('');
      setTab('definition');
      setFile(undefined);
      setDefinition(JSON.stringify(initialDefinition('Projektziel beschreiben'), null, 2));
      return;
    }
    if (idePlanAction.kind === 'select' && idePlanAction.id) {
      if (!canLeave()) {
        return;
      }
      const planId = idePlanAction.id;
      void action(async () => {
        accept(await hub.planGet(planId));
        setFile(undefined);
        setTab('tasks');
      });
    }
  }, [idePlanAction]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const state = location.state as { ideOpen?: { root: string; path: string } } | null;
    const request = state?.ideOpen;
    if (!request || typeof request.root !== 'string' || typeof request.path !== 'string') {
      return;
    }
    let active = true;
    void hub.ideRoot(request.root).then((workspaceRoot) => {
      if (!active) {
        return;
      }
      if (root && root !== workspaceRoot) {
        setSnapshot(null);
        setTitle('');
        setDefinition(JSON.stringify(initialDefinition('Projektziel beschreiben'), null, 2));
      }
      setIdeRootPath(workspaceRoot);
      setFile(request.path);
      setTab('editor');
    }).catch((reason: unknown) => {
      if (active) {
        setError(String(reason));
      }
    });
    return () => { active = false; };
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = (next: PlanSnapshot) => {
    setSnapshot(next);
    setIdeRootPath(next.workspaceRoot);
    setTitle(next.plan.title);
    setDefinition(JSON.stringify(definitionOf(next), null, 2));
    setScopeOpen(false);
    setInspectedRevision(next.plan.currentRevisionId);
    setPreviousDefinition(null);
  };

  const refresh = () => Promise.resolve();

  const action = async (operation: () => Promise<void>) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const dirty = snapshot
    ? title !== snapshot.plan.title || definition !== JSON.stringify(definitionOf(snapshot), null, 2)
    : Boolean(title.trim()) || definition !== JSON.stringify(initialDefinition('Projektziel beschreiben'), null, 2);

  useBlocker(() => {
    if (!dirty && !editorDirty) {
      return false;
    }
    return !window.confirm('Ungespeicherte Änderungen verwerfen und die Ansicht verlassen?');
  });

  useEffect(() => {
    if (root) {
      useHub.setState({ activeCwd: root });
    }
  }, [root]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const canLeave = () => (!dirty && !editorDirty) || window.confirm('Ungespeicherte Änderungen verwerfen?');

  const pickWorkspace = () => action(async () => {
    const folder = await hub.pickFolder();
    if (!folder) {
      return;
    }
    const resolved = await hub.ideRoot(folder);
    setIdeRootPath(resolved);
    setFile(undefined);
    useHub.getState().addProject(resolved);
  });

  const save = () => action(async () => {
    const parsed: unknown = JSON.parse(definition);
    const next = await hub.planSave({
      id: snapshot?.plan.id,
      expectedRevisionId: snapshot?.plan.currentRevisionId,
      workspaceRoot: root,
      title,
      definition: parsed as PlanDefinition,
    });
    accept(next);
    await refresh();
  });

  const approval = () => action(async () => {
    if (!snapshot || dirty || inspectedRevision !== snapshot.plan.currentRevisionId) {
      throw new Error('Zuerst die aktuelle Revision speichern');
    }
    const allowedTools = ['read', ...(allowWrite ? ['write'] : []), ...(allowShell ? ['shell'] : []), ...(allowNetwork ? ['network'] : [])];
    const scope: ApprovalScope = {
      workspaceRoot: root,
      allowedPaths: paths.split('\n').map((path) => path.trim()).filter(Boolean),
      allowedTools,
      allowShell,
      allowNetwork,
    };
    accept(await hub.planApprove(snapshot.plan.id, snapshot.plan.currentRevisionId, scope));
    await refresh();
  });

  const revision = snapshot?.revisions.find((candidate) => candidate.id === inspectedRevision) ?? snapshot?.revisions.at(-1);

  return (
    <div className="flex h-full min-h-0 bg-bg">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-surface/40 px-3 py-2">
          <div className="flex items-center gap-0.5 rounded-full border border-edge bg-surface/80 p-0.5">
            {WORKSPACE_TABS.map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={cx(
                  'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                  tab === item.id ? 'bg-overlay text-fg shadow-xs' : 'text-subtle hover:text-muted',
                )}
              >
                <Icon name={item.icon} size={12} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {tab !== 'editor' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                aria-label="Plantitel"
                className="field !w-48 !py-1 text-[12px]"
                placeholder="Titel des Plans"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <button className="btn btn-primary !py-1 text-[11.5px]" disabled={busy || !root || !title.trim()} onClick={() => void save()}>
                Speichern{dirty ? ' •' : ''}
              </button>
              <button
                className="btn !py-1 text-[11.5px]"
                disabled={busy || !snapshot || dirty || inspectedRevision !== snapshot.plan.currentRevisionId || snapshot.plan.status === 'archived'}
                onClick={() => setScopeOpen((previous) => !previous)}
              >
                Freigabe
              </button>
              <button
                className="btn !py-1 text-[11.5px]"
                disabled={busy}
                onClick={() => {
                  if (!canLeave()) {
                    return;
                  }
                  navigate('/multi', { state: { cwd: root, goal: title.trim() } });
                }}
              >
                <Icon name="lucide:sparkles" size={12} />
                <span>Mit KI</span>
              </button>
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="mx-3 mt-2 flex items-center gap-2 rounded-lumen border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-bad">
            <Icon name="lucide:triangle-alert" size={14} />
            <span className="flex-1">{error}</span>
            <button className="icon-btn !size-5" onClick={() => setError('')}><Icon name="lucide:x" size={12} /></button>
          </div>
        )}

        {scopeOpen && (
          <div className="space-y-2.5 border-b border-edge bg-surface/60 px-4 py-3 text-[12.5px]">
            <div className="flex items-center justify-between">
              <span className="font-medium">Freigabe für Revision {revision?.revision}</span>
              <button className="icon-btn !size-6" onClick={() => setScopeOpen(false)}><Icon name="lucide:x" size={13} /></button>
            </div>
            <label className="block text-[11.5px] text-muted">
              Erlaubte Pfade relativ zum Workspace (ein Pfad pro Zeile)
              <textarea className="field mt-1 block min-h-16 w-full font-mono text-[12px]" value={paths} onChange={(event) => setPaths(event.target.value)} />
            </label>
            <div className="flex flex-wrap items-center gap-4 text-[12px]">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={allowWrite} onChange={(event) => setAllowWrite(event.target.checked)} /> Dateien schreiben</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={allowShell} onChange={(event) => setAllowShell(event.target.checked)} /> Shell</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={allowNetwork} onChange={(event) => setAllowNetwork(event.target.checked)} /> Netzwerk</label>
              <div className="flex-1" />
              <button className="btn btn-primary !py-1 text-[12px]" disabled={busy} onClick={() => void approval()}>
                Scope freigeben
              </button>
            </div>
          </div>
        )}

        {tab === 'definition' && <DefinitionEditor text={definition} onChange={setDefinition} />}

        {tab === 'tasks' && (
          <div className="min-h-0 flex-1 overflow-auto p-5">
            <div className="mx-auto max-w-4xl">
              {snapshot && (
                <section className="mb-5 space-y-2.5 rounded-lumen border border-edge bg-surface/60 p-4">
                  <h2 className="text-[13px] font-semibold">Rückfragen</h2>
                  {snapshot.questions.filter((question) => question.revisionId === snapshot.plan.currentRevisionId).map((question) => (
                    <div key={question.id} className="space-y-1 text-[12.5px]">
                      <p>{question.question}</p>
                      {question.answer ? (
                        <p className="text-muted">{question.answer}</p>
                      ) : (
                        <div className="flex gap-2">
                          <input className="field flex-1" aria-label="Antwort" value={answers[question.id] ?? ''} onChange={(event) => setAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))} />
                          <button className="btn" disabled={busy || dirty || !answers[question.id]?.trim()} onClick={() => void action(async () => { accept(await hub.planAnswer(snapshot.plan.id, question.id, answers[question.id])); })}>Antwort speichern</button>
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <input aria-label="Neue Rückfrage" className="field flex-1" placeholder="Offene Frage zum Plan" value={questionText} onChange={(event) => setQuestionText(event.target.value)} />
                    <button className="btn" disabled={busy || dirty || !questionText.trim()} onClick={() => void action(async () => { accept(await hub.planAsk(snapshot.plan.id, snapshot.plan.currentRevisionId, questionText)); setQuestionText(''); await refresh(); })}>Frage hinzufügen</button>
                  </div>
                </section>
              )}
              {!revision && (
                <p className="py-10 text-center text-[13px] text-subtle">
                  Wähle einen Plan oder erstelle unter „Plan“ eine neue Revision.
                </p>
              )}
              {revision && (
                <>
                  <h2 className="mb-4 text-[18px] font-semibold">{revision.objective}</h2>
                  {[...revision.phases].sort((left, right) => left.order - right.order).map((phase) => (
                    <section key={phase.id} className="mb-6">
                      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">{phase.title}</h3>
                      <div className="space-y-2">
                        {revision.tasks.filter((task) => task.phaseId === phase.id).sort((left, right) => left.order - right.order).map((task) => (
                          <article key={task.id} className="rounded-lumen border border-edge bg-surface/60 p-3.5">
                            <h4 className="font-medium text-fg">{task.title} <span className="ml-1.5 text-[11px] text-subtle">{task.priority} · {task.complexity}</span></h4>
                            <p className="my-1.5 text-[12.5px] text-muted">{task.description}</p>
                            {task.dependencies.length > 0 && <p className="text-[11.5px] text-subtle">Abhängigkeiten: {task.dependencies.join(', ')}</p>}
                            <ul className="my-2 list-inside list-disc text-[12.5px] text-muted">
                              {task.acceptanceCriteria.map((criterion) => (
                                <li key={criterion.id}>{criterion.description} <span className="text-subtle">({criterion.verification})</span></li>
                              ))}
                            </ul>
                            <div className="flex flex-wrap gap-1.5">
                              {task.expectedFiles.map((path) => (
                                <button key={path} className="btn !py-0.5 text-[11.5px]" onClick={() => { setFile(path); setTab('editor'); }}>
                                  <Icon name="lucide:file-code" size={12} />
                                  <span>{path}</span>
                                </button>
                              ))}
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        {tab === 'history' && (
          <div className="min-h-0 flex-1 overflow-auto p-5 text-[13px]">
            <div className="mx-auto max-w-4xl">
              {!snapshot ? (
                <p className="py-10 text-center text-subtle">Noch kein Plan geladen.</p>
              ) : (
                <>
                  <div className="mb-4 flex gap-2">
                    <button className="btn" onClick={() => void action(async () => {
                      const exported = await hub.planExport(snapshot.plan.id);
                      const url = URL.createObjectURL(new Blob([exported], { type: 'application/json' }));
                      const anchor = document.createElement('a');
                      anchor.href = url;
                      anchor.download = 'quorum-plan.json';
                      anchor.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })}>Exportieren</button>
                    <button className="btn" disabled={busy} onClick={() => {
                      if (!canLeave()) {
                        return;
                      }
                      void action(async () => { accept(await hub.planArchive(snapshot.plan.id)); await refresh(); });
                    }}>Archivieren</button>
                  </div>
                  <h2 className="mb-2 font-medium">Revisionen</h2>
                  <div className="mb-3 flex flex-wrap gap-2">
                    {snapshot.revisions.map((candidate) => (
                      <button key={candidate.id} className="btn text-[12px]" onClick={() => {
                        setInspectedRevision(candidate.id);
                        setPreviousDefinition(JSON.stringify({ ...candidate, contentHash: undefined }, null, 2));
                      }}>Revision {candidate.revision} · {candidate.contentHash.slice(0, 10)}</button>
                    ))}
                  </div>
                  {revision && previousDefinition && (
                    <button className="btn mb-2 text-[12px]" onClick={() => {
                      const { objective, requirements, constraints, assumptions, outOfScope, phases, tasks, modelAssignments } = revision;
                      setDefinition(JSON.stringify({ objective, requirements, constraints, assumptions, outOfScope, phases, tasks, modelAssignments }, null, 2));
                      setTab('definition');
                    }}>Als neuen Entwurf übernehmen</button>
                  )}
                  {previousDefinition && <pre className="my-3 max-h-80 overflow-auto rounded-lumen border border-edge bg-surface p-3 text-[12px]">{previousDefinition}</pre>}
                  <h2 className="my-3 font-medium">Freigaben</h2>
                  {snapshot.approvals.map((item) => (
                    <div key={item.id} className="mb-2 rounded-lumen border border-edge bg-surface/60 p-3">
                      <p className="text-[12px] text-muted">{item.approvedAt} · {item.revokedAt ? 'widerrufen' : item.revisionId === snapshot.plan.currentRevisionId ? 'aktuelle Revision' : 'alte Revision'}</p>
                      <pre className="mt-1 overflow-auto text-[11.5px]">{JSON.stringify(item.scope, null, 2)}</pre>
                      {!item.revokedAt && <button className="btn mt-2 text-[11.5px]" disabled={busy || dirty} onClick={() => void action(async () => { accept(await hub.planRevoke(snapshot.plan.id, item.id)); await refresh(); })}>Widerrufen</button>}
                    </div>
                  ))}
                  <h2 className="my-3 font-medium">Audit</h2>
                  {snapshot.events.map((event) => (
                    <p key={event.id} className="py-1 font-mono text-[11.5px] text-muted">#{event.sequence} {event.createdAt} {event.type}</p>
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        {tab === 'editor' && !root && (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <div className="mb-4 grid size-14 place-items-center rounded-2xl border border-edge bg-surface text-accent">
              <Icon name="lucide:code-2" size={26} />
            </div>
            <h1 className="mb-1.5 text-[20px] font-semibold tracking-tight text-fg">IDE Workspace</h1>
            <p className="mb-5 max-w-md text-[13px] text-muted">
              Öffne einen Projektordner, um Dateien mit Monaco-Editor, LSP-Diagnosen und Schnellsuche zu bearbeiten.
            </p>
            <button className="btn btn-primary !rounded-full !px-4" onClick={() => void pickWorkspace()}>
              <Icon name="lucide:folder-open" size={14} />
              <span>Workspace öffnen</span>
            </button>
          </div>
        )}

        {root && (
          <div className={`${tab === 'editor' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}>
            <WorkspaceEditor key={root} root={root} file={file} onDirty={setEditorDirty} />
          </div>
        )}
      </section>
    </div>
  );
}
