import { DefinitionEditor } from './DefinitionEditor';
import { useBlocker, useNavigate } from 'react-router-dom';
import { useHub } from '@/lib/store';
import { useEffect, useState } from 'react';
import type { ApprovalScope, Plan, PlanDefinition, PlanSnapshot } from '@shared/plan/types';
import { initialDefinition } from '@shared/plan/validation';
import { hub } from '@/lib/api';
import { WorkspaceEditor } from '@/components/ide/WorkspaceEditor';

function definitionOf(snapshot: PlanSnapshot): PlanDefinition {
  const revision = snapshot.revisions[snapshot.revisions.length - 1];
  return {
    objective: revision.objective, requirements: revision.requirements, constraints: revision.constraints,
    assumptions: revision.assumptions, outOfScope: revision.outOfScope, phases: revision.phases,
    tasks: revision.tasks, modelAssignments: revision.modelAssignments,
  };
}

export function PlanWorkspace() {
  const navigate = useNavigate();
  const [editorDirty, setEditorDirty] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [snapshot, setSnapshot] = useState<PlanSnapshot | null>(null);
  const [root, setRoot] = useState('');
  const [title, setTitle] = useState('');
  const [definition, setDefinition] = useState(JSON.stringify(initialDefinition('Projektziel beschreiben'), null, 2));
  const [tab, setTab] = useState<'tasks' | 'definition' | 'history' | 'editor'>('definition');
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

  const accept = (next: PlanSnapshot) => {
    setSnapshot(next);
    setRoot(next.workspaceRoot);
    setTitle(next.plan.title);
    setDefinition(JSON.stringify(definitionOf(next), null, 2));
    setScopeOpen(false);
    setInspectedRevision(next.plan.currentRevisionId);
    setPreviousDefinition(null);
  };
  const refresh = () => hub.planList().then(setPlans);
  useEffect(() => { void refresh().catch((reason: unknown) => setError(String(reason))); }, []);
  const action = async (operation: () => Promise<void>) => {
    if (busy) { return; }
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const dirty = snapshot ? title !== snapshot.plan.title || definition !== JSON.stringify(definitionOf(snapshot), null, 2) : !!title.trim() || definition !== JSON.stringify(initialDefinition('Projektziel beschreiben'), null, 2);
  useBlocker(() => {
    if (!dirty && !editorDirty) { return false; }
    return !window.confirm('Ungespeicherte Änderungen verwerfen und die Ansicht verlassen?');
  });
  useEffect(() => {
    if (root) { useHub.setState({ activeCwd: root }); }
  }, [root]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const canLeave = () => (!dirty && !editorDirty) || window.confirm('Ungespeicherte Änderungen verwerfen?');
  const save = () => action(async () => {
    const parsed: unknown = JSON.parse(definition);
    const next = await hub.planSave({ id: snapshot?.plan.id, expectedRevisionId: snapshot?.plan.currentRevisionId, workspaceRoot: root, title, definition: parsed as PlanDefinition });
    accept(next);
    await refresh();
  });
  const approval = () => action(async () => {
    if (!snapshot || dirty || inspectedRevision !== snapshot.plan.currentRevisionId) { throw new Error('Zuerst die aktuelle Revision speichern'); }
    const allowedTools = ['read', ...(allowWrite ? ['write'] : []), ...(allowShell ? ['shell'] : []), ...(allowNetwork ? ['network'] : [])];
    const scope: ApprovalScope = { workspaceRoot: root, allowedPaths: paths.split('\n').map((path) => path.trim()).filter(Boolean), allowedTools, allowShell, allowNetwork };
    accept(await hub.planApprove(snapshot.plan.id, snapshot.plan.currentRevisionId, scope));
    await refresh();
  });
  const revision = snapshot?.revisions.find((candidate) => candidate.id === inspectedRevision) ?? snapshot?.revisions.at(-1);

  return <div className="flex h-full min-h-0">
    <aside className="w-56 shrink-0 overflow-auto border-r border-edge p-3">
      <label className="btn mb-2 block cursor-pointer text-center">Plan importieren<input className="hidden" type="file" accept=".json,application/json" onChange={(event) => {
        const selected = event.target.files?.[0];
        event.target.value = '';
        if (!selected || !canLeave()) { return; }
        void action(async () => {
          if (selected.size > 2_000_000) { throw new Error('Import darf höchstens 2 MB groß sein'); }
          const folder = await hub.pickFolder();
          if (!folder) { return; }
          accept(await hub.planImport(folder, JSON.parse(await selected.text()) as unknown));
          await refresh();
        });
      }} /></label>
      <button className="btn mb-4 w-full" disabled={busy} onClick={() => {
        if (!canLeave()) { return; }
        setSnapshot(null); setEditorDirty(false); setTitle(''); setRoot(''); setTab('definition'); setFile(undefined);
        setDefinition(JSON.stringify(initialDefinition('Projektziel beschreiben'), null, 2));
      }}>Neuer Plan</button>
      {plans.map((plan) => <button key={plan.id} className={`mb-1 block w-full rounded p-2 text-left hover:bg-hover ${snapshot?.plan.id === plan.id ? 'bg-hover' : ''}`} disabled={busy} onClick={() => {
        if (!canLeave()) { return; }
        void action(async () => { accept(await hub.planGet(plan.id)); setFile(undefined); });
      }}><span className="block truncate text-sm">{plan.title}</span><span className="text-xs text-muted">{plan.status}</span></button>)}
    </aside>
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-edge bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-semibold">Pläne & Workspace</h1>
            <p className="mt-1 text-sm text-muted">Hier bearbeitest und speicherst du Pläne manuell. KI-Planung startest du im Multi-Agent-Modus.</p>
          </div>
          <button className="btn" disabled={busy} onClick={() => {
            if (!canLeave()) { return; }
            navigate('/multi', { state: { cwd: root, goal: title.trim() } });
          }}>Mit KI planen & umsetzen →</button>
        </div>
        <p className="mt-2 text-xs text-muted">Dort: Ziel beschreiben → Ordner wählen → Modelle hinzufügen → „Plan → Umsetzung → Review“ → Starten. Dieser Ablauf kann Dateien ändern und ist noch nicht mit den gespeicherten Planrevisionen verbunden.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-edge p-3">
        <input aria-label="Plantitel" className="input min-w-40 flex-1" placeholder="Titel des Plans" value={title} onChange={(event) => setTitle(event.target.value)} />
        <button className="btn" disabled={busy || !!snapshot} onClick={() => { void action(async () => { const folder = await hub.pickFolder(); if (folder) { setRoot(await hub.ideRoot(folder)); } }); }}>Workspace wählen</button>
        <button className="btn" disabled={busy || !root || !title.trim()} onClick={() => { void save(); }}>Revision speichern{dirty ? ' •' : ''}</button>
        <button className="btn" disabled={busy || !snapshot || !!dirty || inspectedRevision !== snapshot.plan.currentRevisionId || snapshot.plan.status === 'archived'} onClick={() => setScopeOpen((previous) => !previous)}>Freigabe prüfen</button>
      </div>
      <div className="px-3 py-2 text-xs text-muted">{root || 'Workspace auswählen'}{revision ? ` · Revision ${revision.revision} · ${snapshot?.plan.status}` : ''}</div>
      {error && <div role="alert" className="p-3 text-sm text-red-400">{error}</div>}
      {scopeOpen && <div className="space-y-2 border-y border-edge p-3 text-sm">
        <p>Freigabe für die gespeicherte Revision {revision?.revision}. Jede Änderung benötigt eine neue Freigabe.</p>
        <label className="block">Erlaubte Pfade relativ zum Workspace (ein Pfad pro Zeile)<textarea className="input block w-full" value={paths} onChange={(event) => setPaths(event.target.value)} /></label>
        <div className="flex gap-4">
          <label><input type="checkbox" checked={allowWrite} onChange={(event) => setAllowWrite(event.target.checked)} /> Dateien schreiben</label>
          <label><input type="checkbox" checked={allowShell} onChange={(event) => setAllowShell(event.target.checked)} /> Shell</label>
          <label><input type="checkbox" checked={allowNetwork} onChange={(event) => setAllowNetwork(event.target.checked)} /> Netzwerk</label>
        </div>
        <p className="text-muted">Die Freigabe wird protokolliert. Automatische Agent-Ausführung ist noch nicht angebunden.</p>
        <button className="btn" disabled={busy} onClick={() => { void approval(); }}>Diese Revision und diesen Scope freigeben</button>
      </div>}
      <nav className="flex gap-1 border-b border-edge px-3" aria-label="Planansicht">
        {(['tasks', 'definition', 'history', 'editor'] as const).map((item) => <button key={item} className={`px-3 py-2 text-sm ${tab === item ? 'bg-hover' : ''}`} onClick={() => setTab(item)}>{({ tasks: 'Aufgaben', definition: 'Plan bearbeiten', history: 'Revisionen & Audit', editor: 'Editor' })[item]}</button>)}
      </nav>
      {tab === 'definition' && <DefinitionEditor text={definition} onChange={setDefinition} />}
      {tab === 'tasks' && <div className="min-h-0 flex-1 overflow-auto p-4">
        {snapshot && <section className="mb-4 space-y-2 border-b border-edge pb-4">
          <h2 className="font-medium">Rückfragen</h2>
          {snapshot.questions.filter((question) => question.revisionId === snapshot.plan.currentRevisionId).map((question) => <div key={question.id} className="text-sm">
            <p>{question.question}</p>
            {question.answer ? <p className="text-muted">{question.answer}</p> : <div className="flex gap-2">
              <input className="input flex-1" aria-label="Antwort" value={answers[question.id] ?? ''} onChange={(event) => setAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))} />
              <button className="btn" disabled={busy || !!dirty || !answers[question.id]?.trim()} onClick={() => { void action(async () => { accept(await hub.planAnswer(snapshot.plan.id, question.id, answers[question.id])); }); }}>Antwort speichern</button>
            </div>}
          </div>)}
          <div className="flex gap-2"><input aria-label="Neue Rückfrage" className="input flex-1" placeholder="Offene Frage zum Plan" value={questionText} onChange={(event) => setQuestionText(event.target.value)} /><button className="btn" disabled={busy || !!dirty || !questionText.trim()} onClick={() => { void action(async () => { accept(await hub.planAsk(snapshot.plan.id, snapshot.plan.currentRevisionId, questionText)); setQuestionText(''); await refresh(); }); }}>Frage hinzufügen</button></div>
        </section>}
        {!revision && <p className="text-muted">Workspace und Titel wählen, unter „Plan bearbeiten“ Aufgaben definieren und die erste Revision speichern.</p>}
        {revision && <><h2 className="mb-4 text-lg">{revision.objective}</h2>{[...revision.phases].sort((left, right) => left.order - right.order).map((phase) => <section key={phase.id} className="mb-5">
          <h3 className="mb-2 font-medium">{phase.title}</h3>
          {revision.tasks.filter((task) => task.phaseId === phase.id).sort((left, right) => left.order - right.order).map((task) => <article key={task.id} className="mb-2 rounded border border-edge p-3">
            <h4 className="font-medium">{task.title} <span className="text-xs text-muted">{task.priority} · {task.complexity}</span></h4>
            <p className="my-2 text-sm text-muted">{task.description}</p>
            {task.dependencies.length > 0 && <p className="text-xs">Abhängigkeiten: {task.dependencies.join(', ')}</p>}
            <ul className="my-2 list-inside list-disc text-sm">{task.acceptanceCriteria.map((criterion) => <li key={criterion.id}>{criterion.description} <span className="text-muted">({criterion.verification})</span></li>)}</ul>
            <div className="flex flex-wrap gap-1">{task.expectedFiles.map((path) => <button key={path} className="btn text-xs" onClick={() => { setFile(path); setTab('editor'); }}>{path}</button>)}</div>
          </article>)}
        </section>)}</>}
      </div>}
      {tab === 'history' && snapshot && <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
        <div className="mb-4 flex gap-2">
          <button className="btn" onClick={() => { void action(async () => {
            const exported = await hub.planExport(snapshot.plan.id);
            const url = URL.createObjectURL(new Blob([exported], { type: 'application/json' }));
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'quorum-plan.json'; anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }); }}>Exportieren</button>
          <button className="btn" disabled={busy} onClick={() => {
            if (!canLeave()) { return; }
            void action(async () => { accept(await hub.planArchive(snapshot.plan.id)); await refresh(); });
          }}>Archivieren</button>
        </div>
        <h2 className="mb-2 font-medium">Revisionen</h2>
        {snapshot.revisions.map((candidate) => <button key={candidate.id} className="btn mb-2 mr-2" onClick={() => {
          setInspectedRevision(candidate.id);
          setPreviousDefinition(JSON.stringify({ ...candidate, contentHash: undefined }, null, 2));
        }}>Revision {candidate.revision} · {candidate.contentHash.slice(0, 10)}</button>)}
        {revision && previousDefinition && <button className="btn mb-2" onClick={() => {
          const { objective, requirements, constraints, assumptions, outOfScope, phases, tasks, modelAssignments } = revision;
          setDefinition(JSON.stringify({ objective, requirements, constraints, assumptions, outOfScope, phases, tasks, modelAssignments }, null, 2));
          setTab('definition');
        }}>Als neuen Entwurf übernehmen</button>}
        {previousDefinition && <pre className="my-3 max-h-80 overflow-auto border border-edge p-3">{previousDefinition}</pre>}
        <h2 className="my-3 font-medium">Freigaben</h2>
        {snapshot.approvals.map((item) => <div key={item.id} className="mb-2 border border-edge p-2">
          <p>{item.approvedAt} · {item.revokedAt ? 'widerrufen' : item.revisionId === snapshot.plan.currentRevisionId ? 'aktuelle Revision' : 'alte Revision'}</p>
          <pre className="overflow-auto text-xs">{JSON.stringify(item.scope, null, 2)}</pre>
          {!item.revokedAt && <button className="btn" disabled={busy || !!dirty} onClick={() => { void action(async () => { accept(await hub.planRevoke(snapshot.plan.id, item.id)); await refresh(); }); }}>Widerrufen</button>}
        </div>)}
        <h2 className="my-3 font-medium">Audit</h2>
        {snapshot.events.map((event) => <p key={event.id} className="py-1 font-mono text-xs">#{event.sequence} {event.createdAt} {event.type}</p>)}
      </div>}
      {root && <div className={`${tab === 'editor' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}><WorkspaceEditor key={root} root={root} file={file} onDirty={setEditorDirty} /></div>}
    </section>
  </div>;
}
