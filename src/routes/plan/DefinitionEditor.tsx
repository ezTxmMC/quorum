import { useState } from 'react';
import type { PlanDefinition, PlanTask } from '@shared/plan/types';
import { initialDefinition } from '@shared/plan/validation';

export function DefinitionEditor({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  const [raw, setRaw] = useState(false);
  let definition: PlanDefinition | undefined;
  try {
    const parsed = JSON.parse(text) as PlanDefinition;
    if (typeof parsed.objective === 'string' && Array.isArray(parsed.tasks) && Array.isArray(parsed.phases)
      && ['requirements', 'constraints', 'assumptions', 'outOfScope'].every((key) => Array.isArray(parsed[key as keyof PlanDefinition]))
      && parsed.phases.every((phase) => phase && typeof phase.id === 'string' && typeof phase.title === 'string')
      && parsed.tasks.every((task) => task && typeof task.id === 'string' && typeof task.title === 'string' && typeof task.description === 'string'
        && Array.isArray(task.dependencies) && Array.isArray(task.expectedFiles) && Array.isArray(task.instructions)
        && Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.every((criterion) => criterion && typeof criterion.id === 'string' && typeof criterion.description === 'string'))) {
      definition = parsed;
    }
  } catch { /* Invalid JSON remains editable in the raw view. */ }
  const update = (next: PlanDefinition) => onChange(JSON.stringify(next, null, 2));
  const updateTask = (id: string, changes: Partial<PlanTask>) => {
    if (!definition) { return; }
    update({ ...definition, tasks: definition.tasks.map((task) => task.id === id ? { ...task, ...changes } : task) });
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    <button className="btn m-2 self-start" onClick={() => setRaw((previous) => !previous)}>{raw ? 'Formular anzeigen' : 'JSON bearbeiten'}</button>
    {(raw || !definition) && <textarea aria-label="Strukturierte Plandefinition" spellCheck={false} className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-sm outline-none" value={text} onChange={(event) => onChange(event.target.value)} />}
    {!raw && definition && <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-sm">
      <label className="block">Ziel<textarea className="input mt-1 block w-full" value={definition.objective} onChange={(event) => update({ ...definition, objective: event.target.value })} /></label>
      {(['requirements', 'constraints', 'assumptions', 'outOfScope'] as const).map((key) => <label key={key} className="block">{({ requirements: 'Anforderungen', constraints: 'Einschränkungen', assumptions: 'Annahmen', outOfScope: 'Nicht im Umfang' })[key]} (eine pro Zeile)<textarea className="input mt-1 block w-full" value={definition[key].join('\n')} onChange={(event) => update({ ...definition, [key]: event.target.value.split('\n').filter(Boolean) })} /></label>)}
      {definition.tasks.map((task) => <fieldset key={task.id} className="space-y-2 rounded border border-edge p-3">
        <legend className="px-1 font-mono text-xs">{task.id}</legend>
        <label className="block">Titel<input className="input mt-1 block w-full" value={task.title} onChange={(event) => updateTask(task.id, { title: event.target.value })} /></label>
        <label className="block">Beschreibung<textarea className="input mt-1 block w-full" value={task.description} onChange={(event) => updateTask(task.id, { description: event.target.value })} /></label>
        <div className="flex flex-wrap gap-3">
          <label>Phase <select className="input" value={task.phaseId} onChange={(event) => updateTask(task.id, { phaseId: event.target.value })}>{definition.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.title}</option>)}</select></label>
          <label>Priorität <select className="input" value={task.priority} onChange={(event) => updateTask(task.id, { priority: event.target.value as PlanTask['priority'] })}>{['low', 'normal', 'high', 'critical'].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Komplexität <select className="input" value={task.complexity} onChange={(event) => updateTask(task.id, { complexity: event.target.value as PlanTask['complexity'] })}>{['simple', 'moderate', 'complex'].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Reihenfolge <input className="input w-20" type="number" value={task.order} onChange={(event) => updateTask(task.id, { order: Number(event.target.value) })} /></label>
        </div>
        <label className="block">Abhängigkeiten<select className="input mt-1 block w-full" multiple value={task.dependencies} onChange={(event) => updateTask(task.id, { dependencies: Array.from(event.target.selectedOptions, (option) => option.value) })}>{definition.tasks.filter((other) => other.id !== task.id).map((other) => <option key={other.id} value={other.id}>{other.title}</option>)}</select></label>
        <label className="block">Erwartete Dateien (eine pro Zeile)<textarea className="input mt-1 block w-full" value={task.expectedFiles.join('\n')} onChange={(event) => updateTask(task.id, { expectedFiles: event.target.value.split('\n').filter(Boolean) })} /></label>
        <label className="block">Anweisungen (eine pro Zeile)<textarea className="input mt-1 block w-full" value={task.instructions.join('\n')} onChange={(event) => updateTask(task.id, { instructions: event.target.value.split('\n').filter(Boolean) })} /></label>
        <p>Akzeptanzkriterien</p>
        {task.acceptanceCriteria.map((criterion) => <div key={criterion.id} className="flex flex-wrap gap-2">
          <input aria-label="Akzeptanzkriterium" className="input min-w-40 flex-1" value={criterion.description} onChange={(event) => updateTask(task.id, { acceptanceCriteria: task.acceptanceCriteria.map((item) => item.id === criterion.id ? { ...item, description: event.target.value } : item) })} />
          <select aria-label="Verifikation" className="input" value={criterion.verification} onChange={(event) => updateTask(task.id, { acceptanceCriteria: task.acceptanceCriteria.map((item) => item.id === criterion.id ? { ...item, verification: event.target.value as typeof item.verification } : item) })}>{['manual', 'test', 'command', 'model_review'].map((value) => <option key={value}>{value}</option>)}</select>
          {criterion.verification === 'command' && <input aria-label="Prüfbefehl" className="input flex-1" value={criterion.command ?? ''} onChange={(event) => updateTask(task.id, { acceptanceCriteria: task.acceptanceCriteria.map((item) => item.id === criterion.id ? { ...item, command: event.target.value } : item) })} />}
          <button className="btn" onClick={() => updateTask(task.id, { acceptanceCriteria: task.acceptanceCriteria.filter((item) => item.id !== criterion.id) })}>Entfernen</button>
        </div>)}
        <div className="flex gap-2">
          <button className="btn" onClick={() => updateTask(task.id, { acceptanceCriteria: [...task.acceptanceCriteria, { id: crypto.randomUUID(), description: 'Ergebnis prüfen', verification: 'manual' }] })}>Kriterium hinzufügen</button>
          <button className="btn" onClick={() => update({ ...definition, tasks: definition.tasks.filter((item) => item.id !== task.id).map((item) => ({ ...item, dependencies: item.dependencies.filter((dependency) => dependency !== task.id) })) })}>Aufgabe entfernen</button>
        </div>
      </fieldset>)}
      <button className="btn" onClick={() => {
        const task = initialDefinition('Neue Aufgabe').tasks[0];
        update({ ...definition, tasks: [...definition.tasks, { ...task, id: crypto.randomUUID(), phaseId: definition.phases[0]?.id ?? 'implementation', order: definition.tasks.length }] });
      }}>Aufgabe hinzufügen</button>
    </div>}
  </div>;
}
