import type { ProviderId } from '@shared/types';
import { useState } from 'react';
import { useMatch } from 'react-router-dom';
import type { Block, Message } from '@shared/types';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { Dot } from '../ModelPicker';
import { Collapse, cx } from '../ui';

type Tool = Extract<Block, { kind: 'tool' }>;

const SUBAGENT = /^(task|agent|invoke_subagent|browser_subagent|define_subagent|subagent)$/i;
const COMMAND = /bash|shell|run_command|command|terminal|exec|send_command_input/i;
const EDIT = /^(edit|multiedit|write|notebookedit|replace_file_content|multi_replace_file_content|write_to_file|sed_file|apply_patch)$|file_change|dateiänderung|notebook_edit/i;

const toolsOf = (messages: Message[]): Tool[] => messages.flatMap((m) => m.blocks.filter((b): b is Tool => b.kind === 'tool'));
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function describe(b: Tool): string {
  const i = (b.input ?? {}) as Record<string, unknown>;
  return str(i.description) ?? str(i.subagent_type) ?? str(i.prompt)?.slice(0, 90) ?? str(i.Task) ?? b.name;
}
function target(b: Tool): string {
  const i = (b.input ?? {}) as Record<string, unknown>;
  const files = Array.isArray(i.files) ? str(i.files[0]) : undefined;
  return str(i.command) ?? str(i.CommandLine) ?? str(i.file_path) ?? str(i.path) ?? str(i.AbsolutePath) ?? str(i.TargetFile) ?? files ?? b.name;
}

function Status({ b }: { b: Tool }) {
  return b.running
    ? <Icon name="lucide:loader-circle" size={13} className="spin shrink-0 text-accent" />
    : b.isError ? <Icon name="lucide:circle-x" size={13} className="shrink-0 text-bad" /> : <Icon name="lucide:circle-check" size={13} className="shrink-0 text-ok" />;
}

function TaskRow({ b }: { b: Tool }) {
  const [open, setOpen] = useState(false);
  const isCmd = COMMAND.test(b.name);
  return (
    <div className="rounded-lumen-sm hover:bg-hover">
      <button className="flex w-full items-center gap-2 px-2 py-1.5 text-left" onClick={() => setOpen((o) => !o)}>
        <Status b={b} />
        <Icon name={isCmd ? 'lucide:terminal' : 'lucide:file-pen-line'} size={13} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={target(b)}>{target(b)}</span>
      </button>
      <Collapse open={open}>
        <pre className="mx-2 mb-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lumen-sm bg-bg p-2 font-mono text-[11px] text-muted">{b.output ? b.output.slice(0, 4000) : b.running ? '…' : t('(keine Ausgabe)')}</pre>
      </Collapse>
    </div>
  );
}

function Section({ title, count, running, children }: { title: string; count: number; running?: number; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 px-1.5 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-wide text-subtle">
        {title}<span className="rounded-full bg-active px-1.5 text-[10px] normal-case tracking-normal text-muted">{count}</span>
        {!!running && <span className="flex items-center gap-1 normal-case tracking-normal text-accent"><span className="pulse-dot size-1.5 rounded-full bg-accent" />{running} {t('läuft')}</span>}
      </div>
      {children}
    </div>
  );
}

/** Rechts/links andockbares Panel: Sub-Agenten und Hintergrundaufgaben (Edits, Bash, Befehle) des aktuellen Chats bzw. Teams. */
export function AgentsPanel() {
  const chat = useMatch('/chat/:id');
  const multi = useMatch('/multi/:id');
  const session = useHub((s) => s.data.sessions.find((x) => x.id === chat?.params.id));
  const run = useHub((s) => s.data.multiRuns.find((x) => x.id === multi?.params.id));

  let tools: Tool[] = [];
  let agents: { key: string; label: string; sub: string; running: boolean; failed?: boolean; provider?: ProviderId }[] = [];

  if (session) {
    tools = toolsOf(session.messages);
    agents = tools.filter((b) => !b.parentId && SUBAGENT.test(b.name)).map((b) => ({
      key: b.id, label: describe(b), running: b.running, failed: b.isError,
      sub: `${b.name} · ${tools.filter((c) => c.parentId === b.id).length} ${t('Schritte')}`,
    }));
  } else if (run) {
    const all = run.turns;
    tools = toolsOf(all.map((x) => x.message));
    agents = all.map((x) => {
      const a = run.config.agents.find((y) => y.id === x.agentId);
      return { key: x.turnId, label: a?.name ?? x.agentId, sub: `${a?.role ?? ''} · ${toolsOf([x.message]).length} ${t('Schritte')}`, running: x.running, failed: x.ok === false, provider: a?.provider };
    });
  }

  const background = tools.filter((b) => COMMAND.test(b.name) || EDIT.test(b.name)).reverse().slice(0, 60);
  const runningBg = background.filter((b) => b.running).length;
  const edits = background.filter((b) => EDIT.test(b.name) && !COMMAND.test(b.name));
  const cmds = background.filter((b) => COMMAND.test(b.name));

  if (!session && !run) return <div className="p-4 text-muted">{t('Öffne einen Chat oder ein Team, um dessen Agenten und Hintergrundaufgaben zu sehen.')}</div>;

  return (
    <div className="h-full overflow-y-auto p-2 text-[12.5px]">
      <Section title={t('Agenten')} count={agents.length} running={agents.filter((a) => a.running).length}>
        {agents.length === 0 && <div className="px-2 py-1.5 text-subtle">{session ? t('Keine Sub-Agenten in diesem Chat.') : t('Noch keine Agenten gestartet.')}</div>}
        {agents.slice().reverse().map((a) => (
          <div key={a.key} className="flex items-center gap-2 rounded-lumen-sm px-2 py-1.5 hover:bg-hover">
            {a.provider ? <Dot id={a.provider} size={7} /> : <Icon name="lucide:bot" size={14} className="shrink-0 text-muted" />}
            <div className="min-w-0 flex-1"><div className="truncate">{a.label}</div><div className="truncate text-[11px] text-subtle">{a.sub}</div></div>
            {a.running ? <span className="pulse-dot size-2 shrink-0 rounded-full bg-accent" /> : a.failed ? <Icon name="lucide:circle-x" size={14} className="shrink-0 text-bad" /> : <Icon name="lucide:circle-check" size={14} className="shrink-0 text-ok" />}
          </div>
        ))}
      </Section>

      <Section title={t('Hintergrundaufgaben')} count={background.length} running={runningBg}>
        {background.length === 0 && <div className="px-2 py-1.5 text-subtle">{t('Noch keine Edits oder Befehle.')}</div>}
        {cmds.length > 0 && <div className="px-2 pb-0.5 pt-1 text-[11px] text-subtle">{t('Befehle')} · {cmds.length}</div>}
        {cmds.map((b) => <TaskRow key={b.id} b={b} />)}
        {edits.length > 0 && <div className={cx('px-2 pb-0.5 text-[11px] text-subtle', cmds.length ? 'pt-2' : 'pt-1')}>{t('Edits')} · {edits.length}</div>}
        {edits.map((b) => <TaskRow key={b.id} b={b} />)}
      </Section>
    </div>
  );
}
