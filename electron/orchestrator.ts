import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSpec, HubEvent, MultiConfig, MultiEvent, PlanTask, ProviderId, ProviderOptions } from '../shared/types';
import { cancelRun, runCli } from './providers/runner';
import { runLocalChat } from './models/chat';
import { modelForCapability } from './models/routing';
import * as G from './git';

type Emit = (e: MultiEvent) => void;

interface Ctx {
  multiId: string;
  config: MultiConfig;
  emit: Emit;
  binaries: Partial<Record<ProviderId, string>>;
  worktreeRoot: string;
  /** Welche Agenten haben einen eigenen Worktree? */
  trees: Map<string, { dir: string; branch: string }>;
  stopped: boolean;
  activeRuns: Set<string>;
  activeTurns: Map<string, string>;
  stageSeq: number;
  /** Gemeinsames "Blackboard": Zusammenfassung der bisherigen Ergebnisse. */
  board: string[];
  providerSessions: Map<string, string>;
  baseSha?: string;
}

const active = new Map<string, Ctx>();

export function stopMulti(multiId: string) {
  const c = active.get(multiId);
  if (!c) return;
  c.stopped = true;
  for (const r of c.activeRuns) cancelRun(r);
}

export function stopMultiTurn(multiId: string, turnId: string): boolean {
  const runId = active.get(multiId)?.activeTurns.get(turnId);
  if (!runId) return false;
  cancelRun(runId);
  return true;
}

const ROLE_TEXT: Record<AgentSpec['role'], string> = {
  planner: 'Du bist der Planer/Lead. Zerlege Ziele in klare Aufgaben, koordiniere und fasse Ergebnisse zusammen.',
  worker: 'Du bist ein Umsetzer. Implementiere die dir zugewiesene Aufgabe sauber, minimal und lauffähig.',
  reviewer: 'Du bist Reviewer. Prüfe Änderungen kritisch auf Fehler, Lücken, Sicherheit und Stil.',
  researcher: 'Du bist Researcher. Untersuche Code und Umgebung gründlich und berichte präzise Erkenntnisse.',
  tester: 'Du bist Tester. Schreibe/führe Tests aus, finde Fehler und berichte reproduzierbar.',
};

function readOnly(agent: AgentSpec): ProviderOptions {
  const o: ProviderOptions = { ...agent.options, fullAccess: false };
  if (agent.provider === 'claude') o.permission = 'plan';
  else if (agent.provider === 'codex') o.sandbox = 'read-only';
  else o.permission = 'plan';
  return o;
}

function writable(agent: AgentSpec, autonomous: boolean): ProviderOptions {
  const o: ProviderOptions = { ...agent.options };
  if (!autonomous || o.fullAccess) return o;
  if (agent.provider === 'claude') o.permission = o.permission === 'plan' || !o.permission || o.permission === 'manual' ? 'acceptEdits' : o.permission;
  else if (agent.provider === 'codex') o.sandbox = o.sandbox === 'read-only' || !o.sandbox ? 'workspace-write' : o.sandbox;
  else o.permission = o.permission === 'plan' || !o.permission || o.permission === 'default' || o.permission === 'accept-edits' ? 'allow-commands' : o.permission;
  return o;
}

function systemFor(agent: AgentSpec, c: Ctx): string {
  const team = c.config.agents.map((a) => `- ${a.name} (${a.id}, ${a.localModel || a.capability ? 'lokal' : a.provider}, ${a.role})`).join('\n');
  return [
    `Du arbeitest als "${agent.name}" in einem Multi-Agent-Team (Hub-Projekt ${c.multiId.slice(0, 8)}).`,
    ROLE_TEXT[agent.role],
    agent.localModel || agent.capability ? 'Du hast keine Werkzeuge und kannst keine Dateien ändern. Antworte nur mit Text.' : '',
    agent.instructions ? `Zusätzliche Anweisungen: ${agent.instructions}` : '',
    `Team:\n${team}`,
    c.config.lang === 'en' ? 'Answer concisely and concretely in English unless the project requires otherwise.' : 'Antworte knapp und konkret auf Deutsch, außer das Projekt verlangt etwas anderes.',
  ].filter(Boolean).join('\n');
}

function clip(s: string, n = 9000): string {
  return s.length > n ? '…' + s.slice(-n) : s;
}

async function turn(c: Ctx, stageId: string, agent: AgentSpec, prompt: string, opts: { readonly?: boolean; cwd?: string; resume?: boolean } = {}): Promise<{ ok: boolean; output: string }> {
  if (c.stopped) return { ok: false, output: '' };
  const turnId = randomUUID();
  const cwd = opts.cwd ?? c.trees.get(agent.id)?.dir ?? c.config.cwd;
  const runId = randomUUID();
  c.activeRuns.add(runId);
  c.activeTurns.set(turnId, runId);
  c.emit({ type: 'agent_start', stageId, turnId, agentId: agent.id, prompt, cwd });
  const localId = agent.localModel ?? (agent.capability ? modelForCapability(agent.capability) : undefined);
  if (agent.localModel || agent.capability) {
    // Lokales Modell: reiner Text-Agent über den Model-Scheduler (keine CLI, keine Werkzeuge).
    const local = !localId
      ? { ok: false, text: '', error: `Kein installiertes Modell für die Fähigkeit „${agent.capability}“` }
      : await runLocalChat({
      runId,
      modelId: localId,
      messages: [{ role: 'system', content: systemFor(agent, c) }, { role: 'user', content: prompt }],
      priority: 1,
      onDelta: (delta) => c.emit({ type: 'agent_event', turnId, agentId: agent.id, event: { type: 'text', delta } }),
    });
    c.activeRuns.delete(runId);
    c.activeTurns.delete(turnId);
    if (!local.ok) c.emit({ type: 'agent_event', turnId, agentId: agent.id, event: { type: 'done', ok: false, error: local.error } });
    const text = local.text.trim();
    c.emit({ type: 'agent_end', turnId, agentId: agent.id, ok: local.ok, output: text });
    return { ok: local.ok, output: text };
  }
  const options = opts.readonly ? readOnly(agent) : writable(agent, c.config.autonomous);
  const sysPrefix = `${systemFor(agent, c)}\n\n---\n\n`;
  const resumeId = opts.resume ? c.providerSessions.get(agent.id) : undefined;
  const res = await runCli(
    {
      runId,
      provider: agent.provider,
      cwd,
      options: agent.provider === 'claude' ? { ...options, systemPrompt: [options.systemPrompt, systemFor(agent, c)].filter(Boolean).join('\n\n') } : options,
      prompt: agent.provider === 'claude' ? prompt : sysPrefix + prompt,
      resume: resumeId ? { sessionId: resumeId } : undefined,
    },
    (event: HubEvent) => c.emit({ type: 'agent_event', turnId, agentId: agent.id, event }),
    c.binaries,
  );
  c.activeRuns.delete(runId);
  c.activeTurns.delete(turnId);
  if (res.sessionId) c.providerSessions.set(agent.id, res.sessionId);
  const output = res.text.trim();
  c.emit({ type: 'agent_end', turnId, agentId: agent.id, ok: res.ok, output });
  return { ok: res.ok, output };
}

const EN: [string, string][] = [
  ['Planung', 'Planning'], ['Umsetzung', 'Build'], ['Korrektur', 'Fixes'], ['Zusammenfassung', 'Summary'], ['Zusammenführen', 'Merging'],
  ['Parallele Bearbeitung', 'Parallel work'], ['Synthese', 'Synthesis'], ['Debatte · Runde', 'Debate · round'], ['Urteil', 'Verdict'], ['Schritt', 'Step'],
  ['Worktree für', 'Worktree for'], ['Merge-Konflikte', 'Merge conflicts'], ['Merge ', 'Merge '], ['Review noch nicht freigegeben – maximale Runden erreicht.', 'Review not approved yet – max rounds reached.'],
  ['Abgebrochen.', 'Cancelled.'], ['Keine Agenten ausgewählt.', 'No agents selected.'], ['Planung fehlgeschlagen', 'Planning failed'], ['fehlgeschlagen', 'failed'],
  ['Interner Fehler im Orchestrator.', 'Internal orchestrator error.'], ['Nicht freigegeben nach', 'Not approved after'], ['Runden', 'rounds'], ['Review freigegeben.', 'Review approved.'],
];
const loc = (c: Ctx, s: string) => (c.config.lang === 'en' ? EN.reduce((acc, [de, en]) => acc.split(de).join(en), s) : s);

function stage(c: Ctx, label: string, agents: AgentSpec[]): string {
  label = loc(c, label);
  const stageId = `s${++c.stageSeq}`;
  c.emit({ type: 'stage_start', stageId, label, agentIds: agents.map((a) => a.id) });
  return stageId;
}
const endStage = (c: Ctx, id: string) => c.emit({ type: 'stage_end', stageId: id });

const byRole = (c: Ctx, role: AgentSpec['role']) => c.config.agents.filter((a) => a.role === role);
const lead = (c: Ctx) => byRole(c, 'planner')[0] ?? c.config.agents[0];

/** Änderungsstand als Text – Reviewer im Nur-Lesen-Modus können oft keine Shell nutzen, daher wird er mitgegeben. */
async function snapshot(c: Ctx): Promise<string> {
  const cwd = c.config.cwd;
  if (!(await G.isRepo(cwd))) return '';
  const parts: string[] = [];
  const st = await G.git(cwd, ['status', '--porcelain']);
  if (c.baseSha) {
    const d = await G.git(cwd, ['diff', '--no-color', c.baseSha]);
    if (d.out.trim()) parts.push('```diff\n' + clip(d.out, 24000) + '\n```');
  } else {
    const d = await G.git(cwd, ['diff', '--no-color', 'HEAD']);
    if (d.out.trim()) parts.push('```diff\n' + clip(d.out, 24000) + '\n```');
  }
  const untracked = st.out.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3)).slice(0, 12);
  for (const f of untracked) {
    try {
      const full = join(cwd, f);
      if (statSync(full).isFile() && statSync(full).size < 20000) parts.push(`Neue Datei ${f}:\n\`\`\`\n${readFileSync(full, 'utf8')}\n\`\`\``);
    } catch { /* ignorieren */ }
  }
  return parts.length ? `\n\n## Änderungsstand im Projekt\n${parts.join('\n\n')}` : '\n\n(Keine Dateiänderungen gegenüber dem Ausgangsstand erkannt.)';
}

function boardText(c: Ctx): string {
  return c.board.length ? `\n\n## Bisherige Ergebnisse im Team\n${clip(c.board.join('\n\n'), 14000)}` : '';
}

// ---- Strategien -------------------------------------------------------------------------------

function parsePlan(text: string, agents: AgentSpec[]): PlanTask[] {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*"tasks"[\s\S]*\})/);
  const fallbackWorker = (agents.find((a) => a.role === 'worker') ?? agents[0]).id;
  try {
    const raw = JSON.parse(m ? m[1] : text) as { tasks?: Partial<PlanTask>[] } | Partial<PlanTask>[];
    const list = Array.isArray(raw) ? raw : raw.tasks ?? [];
    const ids = new Set(agents.map((a) => a.id));
    const names = new Map(agents.map((a) => [a.name.toLowerCase(), a.id]));
    const tasks = list.map((t, i) => ({
      id: String(t.id ?? `t${i + 1}`),
      title: String(t.title ?? `Aufgabe ${i + 1}`),
      description: String(t.description ?? t.title ?? ''),
      assignee: ids.has(String(t.assignee)) ? String(t.assignee) : names.get(String(t.assignee).toLowerCase()) ?? fallbackWorker,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
    }));
    if (tasks.length) return tasks;
  } catch { /* Fallback unten */ }
  return [{ id: 't1', title: 'Gesamtaufgabe', description: text.slice(0, 4000), assignee: fallbackWorker, dependsOn: [] }];
}

async function planExecute(c: Ctx) {
  const planner = lead(c);
  const workers = c.config.agents.filter((a) => a.role === 'worker' || a.role === 'tester' || a.role === 'researcher');
  const exec = workers.length ? workers : [planner];

  // 1. Planung
  let s = stage(c, 'Planung', [planner]);
  const planRes = await turn(c, s, planner,
    `Ziel:\n${c.config.goal}\n\nErkunde bei Bedarf das Projekt (nur lesen) und erstelle einen Plan. Verfügbare Ausführende:\n${exec.map((a) => `- ${a.id}: ${a.name} (${a.provider}, ${a.role})`).join('\n')}\n\nAntworte mit kurzer Begründung und danach EINEM \`\`\`json Block der Form:\n{"tasks":[{"id":"t1","title":"…","description":"detaillierte Anweisung","assignee":"<agent-id>","dependsOn":[]}]}\nVerteile Aufgaben sinnvoll, vermeide Überschneidungen in den Dateien.`,
    { readonly: true });
  endStage(c, s);
  if (!planRes.ok) return fail(c, 'Planung fehlgeschlagen');
  const tasks = parsePlan(planRes.output, exec);
  c.emit({ type: 'plan', tasks });
  c.board.push(`### Plan\n${tasks.map((t) => `- ${t.id} [${t.assignee}] ${t.title}`).join('\n')}`);

  // 2. Ausführung in Wellen
  await setupTrees(c, [...new Set(tasks.map((t) => t.assignee))]);
  const done = new Set<string>();
  let pending = [...tasks];
  while (pending.length && !c.stopped) {
    let wave = pending.filter((t) => t.dependsOn.every((d) => done.has(d) || !tasks.some((x) => x.id === d)));
    if (!wave.length) wave = [pending[0]]; // Zyklus auflösen
    pending = pending.filter((t) => !wave.includes(t));
    const canParallel = c.config.parallel && c.config.isolation === 'worktree';
    // Aufgaben desselben Agenten laufen immer nacheinander.
    const groups = new Map<string, PlanTask[]>();
    for (const t of wave) groups.set(t.assignee, [...(groups.get(t.assignee) ?? []), t]);
    const agentsInWave = [...groups.keys()].map((id) => c.config.agents.find((a) => a.id === id)!);
    s = stage(c, `Umsetzung · ${wave.map((t) => t.title).join(', ')}`.slice(0, 90), agentsInWave);
    const runGroup = async (id: string, ts: PlanTask[]) => {
      const agent = c.config.agents.find((a) => a.id === id)!;
      for (const t of ts) {
        const r = await turn(c, s, agent, `Gesamtziel:\n${c.config.goal}\n\nDeine Aufgabe (${t.id}: ${t.title}):\n${t.description}${boardText(c)}\n\nFühre die Aufgabe jetzt aus. Schließe mit einer kurzen Zusammenfassung deiner Änderungen ab.`);
        c.board.push(`### ${agent.name} · ${t.title}\n${clip(r.output, 2500)}`);
        done.add(t.id);
      }
      await commitTree(c, agent, 'Aufgaben abgeschlossen');
    };
    if (canParallel) await Promise.all([...groups].map(([id, ts]) => runGroup(id, ts)));
    else for (const [id, ts] of groups) await runGroup(id, ts);
    endStage(c, s);
  }
  if (c.stopped) return;

  await mergeTrees(c);

  // 3. Review (+ eine Korrekturrunde je Runde)
  const reviewers = byRole(c, 'reviewer');
  for (let round = 1; round <= Math.max(0, c.config.rounds) && reviewers.length && !c.stopped; round++) {
    s = stage(c, `Review ${round}`, reviewers);
    const snap = await snapshot(c);
    const reviews = await Promise.all(reviewers.map((r) => turn(c, s, r,
      `Ziel:\n${c.config.goal}${boardText(c)}${snap}\n\nPrüfe den aktuellen Stand des Projekts (nur lesen). Beende deine Antwort mit genau einer Zeile: "VERDICT: APPROVED" oder "VERDICT: CHANGES_REQUESTED" und liste davor konkrete Mängel.`, { readonly: true })));
    endStage(c, s);
    const rejected = reviews.filter((r) => /VERDICT:\s*CHANGES_REQUESTED/i.test(r.output));
    reviews.forEach((r, i) => c.board.push(`### Review ${reviewers[i].name}\n${clip(r.output, 2500)}`));
    if (!rejected.length) break;
    if (round === c.config.rounds) { c.emit({ type: 'log', level: 'warn', text: 'Review noch nicht freigegeben – maximale Runden erreicht.' }); break; }
    const fixer = exec[0];
    s = stage(c, `Korrektur ${round}`, [fixer]);
    await turn(c, s, fixer, `Behebe die Mängel aus den Reviews.${boardText(c)}`, { cwd: c.config.cwd });
    endStage(c, s);
  }

  // 4. Abschluss
  s = stage(c, 'Zusammenfassung', [planner]);
  const sum = await turn(c, s, planner, `Fasse das Ergebnis für den Nutzer zusammen: was wurde getan, was ist offen, wie kann man es prüfen?${boardText(c)}${await snapshot(c)}`, { readonly: true });
  endStage(c, s);
  c.emit({ type: 'finished', ok: !c.stopped, summary: sum.output });
}

async function pipeline(c: Ctx) {
  await setupTrees(c, []); // pipeline läuft sequenziell im selben Ordner
  let prev = '';
  for (const [i, a] of c.config.agents.entries()) {
    if (c.stopped) return;
    const s = stage(c, `Schritt ${i + 1} · ${a.name}`, [a]);
    const ro = a.role === 'reviewer' || a.role === 'researcher' || a.role === 'planner';
    const r = await turn(c, s, a, `Gesamtziel:\n${c.config.goal}\n\n${prev ? `Ergebnis des vorherigen Agenten:\n${clip(prev)}\n\n` : ''}Du bist Schritt ${i + 1} von ${c.config.agents.length}. Erledige deinen Teil und gib eine Übergabe für den nächsten Agenten aus.`, { readonly: ro });
    endStage(c, s);
    if (!r.ok) return fail(c, `${a.name} fehlgeschlagen`);
    prev = r.output;
  }
  c.emit({ type: 'finished', ok: true, summary: prev });
}

async function parallelRun(c: Ctx) {
  const l = lead(c);
  const others = c.config.agents.filter((a) => a.id !== l.id);
  const team = others.length ? others : [l];
  const s = stage(c, 'Parallele Bearbeitung', team);
  const rs = await Promise.all(team.map((a) => turn(c, s, a, `Aufgabe:\n${c.config.goal}\n\nBearbeite sie eigenständig (nur lesen/analysieren) und liefere deine beste Lösung bzw. Analyse.`, { readonly: true })));
  endStage(c, s);
  rs.forEach((r, i) => c.board.push(`### ${team[i].name}\n${clip(r.output, 5000)}`));
  const s2 = stage(c, 'Synthese', [l]);
  const sum = await turn(c, s2, l, `Aufgabe:\n${c.config.goal}\n\nVergleiche die Antworten der Teammitglieder, löse Widersprüche und liefere die beste zusammengeführte Antwort.${boardText(c)}`, { readonly: true });
  endStage(c, s2);
  c.emit({ type: 'finished', ok: sum.ok, summary: sum.output });
}

async function debate(c: Ctx) {
  const judge = lead(c);
  const debaters = c.config.agents.length > 1 ? c.config.agents.filter((a) => a.id !== judge.id) : [judge];
  let last: Record<string, string> = {};
  for (let r = 1; r <= Math.max(1, c.config.rounds) && !c.stopped; r++) {
    const s = stage(c, `Debatte · Runde ${r}`, debaters);
    const rs = await Promise.all(debaters.map((a) => {
      const others = debaters.filter((x) => x.id !== a.id).map((x) => `### ${x.name}\n${clip(last[x.id] ?? '(noch keine Antwort)', 4000)}`).join('\n\n');
      return turn(c, s, a, `Frage/Aufgabe:\n${c.config.goal}\n\n${r === 1 ? 'Gib deine Position mit Begründung ab.' : `Position der anderen:\n${others}\n\nGehe auf Gegenargumente ein, korrigiere dich wenn nötig und verfeinere deine Position.`}`, { readonly: true });
    }));
    endStage(c, s);
    debaters.forEach((a, i) => { last[a.id] = rs[i].output; });
  }
  const s = stage(c, 'Urteil', [judge]);
  const v = await turn(c, s, judge, `Du bist Schiedsrichter. Frage:\n${c.config.goal}\n\nPositionen:\n${debaters.map((a) => `### ${a.name}\n${clip(last[a.id] ?? '', 5000)}`).join('\n\n')}\n\nFälle ein begründetes, umsetzbares Urteil.`, { readonly: true });
  endStage(c, s);
  c.emit({ type: 'finished', ok: v.ok, summary: v.output });
}

async function reviewLoop(c: Ctx) {
  const impl = c.config.agents.find((a) => a.role === 'worker') ?? c.config.agents[0];
  const rev = c.config.agents.find((a) => a.role === 'reviewer' && a.id !== impl.id) ?? c.config.agents.find((a) => a.id !== impl.id) ?? impl;
  let feedback = '';
  let approved = false;
  for (let r = 1; r <= Math.max(1, c.config.rounds) && !c.stopped; r++) {
    let s = stage(c, `Umsetzung ${r}`, [impl]);
    const w = await turn(c, s, impl, `Aufgabe:\n${c.config.goal}\n\n${feedback ? `Review-Feedback, das du umsetzen sollst:\n${feedback}` : 'Setze die Aufgabe um.'}`, { resume: r > 1 });
    endStage(c, s);
    if (!w.ok) return fail(c, `${impl.name} fehlgeschlagen`);
    s = stage(c, `Review ${r}`, [rev]);
    const snap = await snapshot(c);
    const v = await turn(c, s, rev, `Aufgabe:\n${c.config.goal}\n\nUmsetzer-Bericht:\n${clip(w.output, 4000)}${snap}\n\nPrüfe den Ist-Zustand des Projekts (nur lesen). Ende mit "VERDICT: APPROVED" oder "VERDICT: CHANGES_REQUESTED" und liste davor konkrete Mängel.`, { readonly: true });
    endStage(c, s);
    feedback = v.output;
    if (/VERDICT:\s*APPROVED/i.test(v.output)) { approved = true; break; }
  }
  c.emit({ type: 'finished', ok: approved, summary: approved ? 'Review freigegeben.' : `Nicht freigegeben nach ${c.config.rounds} Runden.\n\n${feedback}` });
}

// ---- Worktrees ---------------------------------------------------------------------------------

async function setupTrees(c: Ctx, agentIds: string[]) {
  if (c.config.isolation !== 'worktree' || !agentIds.length) return;
  if (!(await G.isRepo(c.config.cwd)) || !(await G.hasCommits(c.config.cwd))) {
    c.emit({ type: 'log', level: 'warn', text: 'Worktree-Isolation benötigt ein Git-Repo mit mindestens einem Commit – arbeite im geteilten Ordner.' });
    c.config.isolation = 'shared';
    return;
  }
  for (const id of agentIds) {
    const dir = join(c.worktreeRoot, c.multiId, id);
    mkdirSync(join(c.worktreeRoot, c.multiId), { recursive: true });
    const branch = `aihub/${c.multiId.slice(0, 8)}/${id}`;
    if (await G.addWorktree(c.config.cwd, dir, branch)) {
      c.trees.set(id, { dir, branch });
      c.emit({ type: 'log', level: 'info', text: `Worktree für ${id}: ${branch}` });
    } else c.emit({ type: 'log', level: 'warn', text: `Worktree für ${id} fehlgeschlagen – nutze geteilten Ordner.` });
  }
}

async function commitTree(c: Ctx, agent: AgentSpec, msg: string) {
  const t = c.trees.get(agent.id);
  if (t) await G.commitAll(t.dir, `${agent.name}: ${msg}`);
}

async function mergeTrees(c: Ctx) {
  if (!c.trees.size) return;
  const s = stage(c, 'Zusammenführen', [lead(c)]);
  for (const [id, t] of c.trees) {
    const res = await G.mergeBranch(c.config.cwd, t.branch);
    if (res.ok) { c.emit({ type: 'log', level: 'info', text: `Merge ${id}: ok` }); continue; }
    c.emit({ type: 'log', level: 'warn', text: `Merge-Konflikte (${id}): ${res.conflicts.join(', ')}` });
    await turn(c, s, lead(c), `Beim Mergen von Branch ${t.branch} sind Konflikte in diesen Dateien aufgetreten:\n${res.conflicts.join('\n')}\n\nLöse sie im Arbeitsverzeichnis (Konfliktmarker entfernen, beide Absichten erhalten), führe \`git add\` für die Dateien aus und schließe den Merge mit \`git commit --no-edit\` ab.`, { cwd: c.config.cwd });
    if (await G.mergeInProgress(c.config.cwd)) {
      await G.abortMerge(c.config.cwd);
      c.emit({ type: 'log', level: 'error', text: `Konflikte von ${id} blieben ungelöst – Merge abgebrochen, Branch ${t.branch} bleibt erhalten.` });
      continue;
    }
  }
  endStage(c, s);
  for (const [, t] of c.trees) {
    // Nur aufräumen, wenn der Branch vollständig gemergt ist.
    const merged = await G.git(c.config.cwd, ['branch', '--merged', 'HEAD', '--list', t.branch]);
    if (merged.out.includes(t.branch)) await G.removeWorktree(c.config.cwd, t.dir, t.branch);
  }
  c.trees.clear();
}

function fail(c: Ctx, msg: string) {
  c.emit({ type: 'finished', ok: false, summary: msg });
}

export async function startMulti(multiId: string, config: MultiConfig, emit: Emit, binaries: Partial<Record<ProviderId, string>>, dataDir: string) {
  const c: Ctx = {
    multiId, config: { ...config, agents: config.agents.map((a) => ({ ...a })) }, emit: (e) => emit(e.type === 'log' ? { ...e, text: loc(c, e.text) } : e.type === 'finished' ? { ...e, summary: e.summary.replace(/^[^\n]{1,100}/, (first) => loc(c, first)) } : e), binaries,
    worktreeRoot: join(dataDir, 'worktrees'), trees: new Map(), stopped: false, activeRuns: new Set(), activeTurns: new Map(), stageSeq: 0, board: [], providerSessions: new Map(),
  };
  active.set(multiId, c);
  try {
    if (await G.isRepo(c.config.cwd) && await G.hasCommits(c.config.cwd)) c.baseSha = (await G.git(c.config.cwd, ['rev-parse', 'HEAD'])).out.trim();
    if (!c.config.agents.length) return fail(c, 'Keine Agenten ausgewählt.');
    switch (c.config.strategy) {
      case 'plan-execute': await planExecute(c); break;
      case 'pipeline': await pipeline(c); break;
      case 'parallel': await parallelRun(c); break;
      case 'debate': await debate(c); break;
      case 'review-loop': await reviewLoop(c); break;
    }
    if (c.stopped) emit({ type: 'finished', ok: false, summary: 'Abgebrochen.' });
  } catch (err) {
    emit({ type: 'log', level: 'error', text: String(err instanceof Error ? err.message : err) });
    fail(c, 'Interner Fehler im Orchestrator.');
  } finally {
    active.delete(multiId);
  }
}
