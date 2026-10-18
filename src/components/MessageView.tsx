import { t } from '@/lib/i18n';
import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PROVIDERS, imageEngineLabel } from '@shared/catalog';
import { hub } from '@/lib/api';
import type { Block, Message } from '@shared/types';
import { Icon } from '@/lib/icons';
import { Markdown } from './Markdown';
import { Collapse, CopyButton, ProviderMark, cx } from './ui';

const TOOL_ICONS: [RegExp, string][] = [
  [/bash|shell|command|run_command|terminal/i, 'lucide:terminal'],
  [/edit|write|replace|file_change|dateiänderung|notebook/i, 'lucide:file-pen-line'],
  [/read|view|cat|list_dir|ls/i, 'lucide:file-text'],
  [/grep|glob|find|search|suche/i, 'lucide:search'],
  [/web|fetch|url|browser/i, 'lucide:globe'],
  [/agent|task|subagent/i, 'lucide:bot'],
  [/todo|aufgabe|manage_task/i, 'lucide:list-checks'],
  [/mcp|:/i, 'lucide:plug'],
];
const toolIcon = (n: string) => TOOL_ICONS.find(([r]) => r.test(n))?.[1] ?? 'lucide:wrench';

function summarize(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const k = ['command', 'CommandLine', 'file_path', 'path', 'AbsolutePath', 'TargetFile', 'pattern', 'query', 'Query', 'url', 'description', 'prompt'].find((x) => typeof o[x] === 'string');
    if (k) return String(o[k]);
    return JSON.stringify(input);
  }
  return String(input);
}

function ToolCard({ b, nested }: { b: Extract<Block, { kind: 'tool' }>; nested: boolean }) {
  const [open, setOpen] = useState(false);
  const sum = summarize(b.input);
  return (
    <div className={cx('rounded-lumen border border-edge bg-surface text-[12.5px]', nested && 'ml-5')}>
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen((o) => !o)}>
        <Icon name={b.running ? 'lucide:loader-circle' : b.isError ? 'lucide:circle-x' : toolIcon(b.name)} size={14} className={cx(b.running && 'spin text-accent', b.isError && 'text-bad', !b.running && !b.isError && 'text-muted')} />
        <span className="shrink-0 font-medium">{b.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-subtle">{sum}</span>
        <Icon name={open ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={14} className="text-subtle" />
      </button>
      <Collapse open={open}>
        <div className="space-y-2 border-t border-edge p-2.5">
          {b.input != null && <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px] text-muted">{typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2)}</pre>}
          {b.output && <pre className={cx('max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lumen-sm bg-bg p-2 font-mono text-[11.5px]', b.isError ? 'text-bad' : 'text-muted')}>{b.output.length > 12000 ? b.output.slice(0, 12000) + '\n…' : b.output}</pre>}
        </div>
      </Collapse>
    </div>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[12.5px] text-subtle">
      <button className="flex items-center gap-1.5 hover:text-muted" onClick={() => setOpen((o) => !o)}>
        <Icon name="lucide:brain" size={14} className={live ? 'pulse-dot' : ''} /> {live ? t('Denkt nach…') : t('Gedankengang')}
        <Icon name={open ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={12} />
      </button>
      <Collapse open={open}><div className="mt-1.5 whitespace-pre-wrap border-l-2 border-edge pl-3 italic">{text}</div></Collapse>
    </div>
  );
}

export const imageUrl = (p: string) => `quorum-img://local/${encodeURIComponent(p)}`;

/** Erzeugtes Bild: Vorschau mit Aktionen, Klick öffnet die Großansicht. */
function GeneratedImage({ path, engine }: { path: string; engine?: string }) {
  const [big, setBig] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!big) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setBig(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [big]);
  const copy = async () => { await hub.copyImage(path); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  const actions = (
    <>
      <button className="icon-btn !size-7" title={t('Kopieren / Copy')} onClick={copy}><Icon name={copied ? 'lucide:check' : 'lucide:copy'} size={14} /></button>
      <button className="icon-btn !size-7" title={t('Speichern unter …')} onClick={() => void hub.saveImageAs(path)}><Icon name="lucide:download" size={14} /></button>
      <button className="icon-btn !size-7" title={t('Im Ordner zeigen')} onClick={() => void hub.revealPath(path)}><Icon name="lucide:folder-open" size={14} /></button>
    </>
  );
  return (
    <div className="pop-in w-fit max-w-full">
      <div className="group/img relative overflow-hidden rounded-lumen-lg border border-edge bg-surface">
        {!loaded && <div className="shimmer aspect-square w-[min(420px,100%)]" />}
        <img src={imageUrl(path)} alt="" onLoad={() => setLoaded(true)} onClick={() => setBig(true)}
          className={cx('block max-h-[480px] max-w-[min(480px,100%)] cursor-zoom-in object-contain transition-opacity duration-300', loaded ? 'opacity-100' : 'absolute opacity-0')} />
        <div className="absolute right-1.5 top-1.5 flex gap-0.5 rounded-lumen bg-bg/80 p-0.5 opacity-0 backdrop-blur transition-opacity group-hover/img:opacity-100">{actions}</div>
      </div>
      {engine && <div className="mt-1 flex items-center gap-1 text-[11px] text-subtle"><Icon name="lucide:sparkles" size={11} /> {imageEngineLabel(engine)}</div>}
      {big && createPortal(
        <div className="bg-in fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm" onClick={() => setBig(false)}>
          <img src={imageUrl(path)} alt="" className="pop-in max-h-full max-w-full rounded-lumen-lg object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <div className="absolute right-4 top-4 flex gap-1 rounded-lumen bg-bg/80 p-1 backdrop-blur" onClick={(e) => e.stopPropagation()}>
            {actions}
            <button className="icon-btn !size-7" title={t('Schließen')} onClick={() => setBig(false)}><Icon name="lucide:x" size={14} /></button>
          </div>
        </div>, document.body)}
    </div>
  );
}

function fmtTok(n?: number) { return n === undefined ? '' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

export const MessageView = memo(function MessageView({ m, live, label }: { m: Message; live?: boolean; label?: string }) {
  if (m.role === 'user') {
    const text = m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('');
    return (
      <div className="fade-in group/msg flex items-start justify-end gap-1">
        <CopyButton title={t('Kopieren / Copy')} className="mt-1 opacity-0 transition-opacity group-hover/msg:opacity-100" text={text} />
        <div className="min-w-0 max-w-[85%] select-text overflow-hidden rounded-lumen-lg rounded-br-md border border-edge bg-surface px-3.5 py-2.5">
          {m.images?.length ? <div className="mb-2 flex flex-wrap gap-1.5">{m.images.map((p) => <span key={p} className="inline-flex items-center gap-1 rounded-md bg-active px-2 py-0.5 text-[11px]"><Icon name="lucide:image" size={12} />{p.split(/[\\/]/).pop()}</span>)}</div> : null}
          <div className="whitespace-pre-wrap text-[14px] leading-relaxed [overflow-wrap:anywhere]">{text}</div>
        </div>
      </div>
    );
  }
  const lastIdx = m.blocks.length - 1;
  const empty = m.blocks.length === 0;
  return (
    <div className="fade-in group/asst">
      {/* Volle Breite wie das Eingabefeld: Anbieter-Icon steht in der Kopfzeile statt in einer eigenen Spalte. */}
      <div className="min-w-0 space-y-2.5 [overflow-wrap:anywhere]">
        {(label || m.provider) && <div className="flex items-center gap-2 text-[11.5px] font-medium text-subtle">{m.provider && <ProviderMark id={m.provider} size={12} />}{label ?? PROVIDERS[m.provider!].name}</div>}
        {empty && live && <div className="flex items-center gap-2 text-muted"><span className="pulse-dot size-2 rounded-full bg-accent" /> {t('arbeitet…')}</div>}
        {m.blocks.map((b, i) => {
          if (b.kind === 'text') return <Markdown key={i} text={b.text} />;
          if (b.kind === 'inject') return <div key={i} className="chip-in ml-auto w-fit max-w-[85%] select-text whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lumen border border-accent/30 bg-accent/10 px-3 py-1.5 text-[13px]"><span className="mr-2 text-[10.5px] font-medium uppercase tracking-wide text-accent">{t('Direkt')}</span>{b.text}</div>;
          if (b.kind === 'thinking') return <Thinking key={i} text={b.text} live={!!live && i === lastIdx} />;
          if (b.kind === 'image') return <GeneratedImage key={b.path} path={b.path} engine={b.engine} />;
          return <ToolCard key={b.id} b={b} nested={!!b.parentId} />;
        })}
        {m.error && <div className="flex gap-2 whitespace-pre-wrap rounded-lumen border border-bad/30 bg-bad/10 px-3 py-2 text-[12.5px] text-bad"><Icon name="lucide:triangle-alert" size={14} className="mt-0.5 shrink-0" /><span>{m.error}</span></div>}
        {!live && m.blocks.some((b) => b.kind === 'text') && (
          <div className="-mb-1 flex opacity-0 transition-opacity group-hover/asst:opacity-100">
            <CopyButton title={t('Antwort kopieren')} text={() => m.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n\n')} />
          </div>
        )}
        {m.usage && (m.usage.inputTokens || m.usage.outputTokens || m.usage.costUsd) ? (
          <div className="flex flex-wrap gap-x-3 text-[11px] text-subtle">
            {m.usage.inputTokens !== undefined && <span>↑ {fmtTok(m.usage.inputTokens)}</span>}
            {m.usage.outputTokens !== undefined && <span>↓ {fmtTok(m.usage.outputTokens)}</span>}
            {m.usage.cachedTokens ? <span>Cache {fmtTok(m.usage.cachedTokens)}</span> : null}
            {m.usage.costUsd !== undefined && <span>${m.usage.costUsd.toFixed(4)}</span>}
            {m.usage.durationMs !== undefined && <span>{(m.usage.durationMs / 1000).toFixed(1)}s</span>}
          </div>
        ) : null}
      </div>
    </div>
  );
});
