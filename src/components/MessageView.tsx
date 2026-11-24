import { SentAttachments } from './SentAttachments';
import { t } from '@/lib/i18n';
import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PROVIDERS, imageEngineLabel } from '@shared/catalog';
import { apiCost, fmtUsd } from '@shared/pricing';
import { hub } from '@/lib/api';
import type { Message } from '@shared/types';
import { Icon } from '@/lib/icons';
import { ToolActivity } from './ToolActivity';
import { Markdown } from './Markdown';
import { Collapse, CopyButton, ProviderMark, cx } from './ui';

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? live;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (live && open && body.current) body.current.scrollTop = body.current.scrollHeight; }, [text, live, open]);
  return (
    <div className="rounded-lumen border border-edge/80 bg-surface/50 px-3 py-2 text-[12.5px] text-subtle">
      <button className="flex w-full items-center gap-1.5 text-left transition-colors hover:text-muted" aria-expanded={open} onClick={() => setExpanded(!open)}>
        <Icon name="lucide:brain" size={14} className={live ? 'pulse-dot text-accent' : ''} />
        <span className={cx('font-medium', live && 'text-shimmer')}>{live ? t('Denkt nach…') : t('Gedankengang')}</span>
        <span className="flex-1" />
        <Icon name="lucide:chevron-right" size={12} className={cx('transition-transform duration-200', open && 'rotate-90')} />
      </button>
      <Collapse open={open}><div ref={body} className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-edge/70 pt-2 italic leading-relaxed">{text}</div></Collapse>
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

/** Zusammenfassung eines kompaktierten Verlaufs: eingeklappt, damit sie den Chat nicht dominiert. */
function CompactedSummary({ m }: { m: Message }) {
  const [open, setOpen] = useState(false);
  const text = m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('');
  const count = m.compaction?.messages ?? m.usage?.turns;
  const saved = m.compaction ? Math.max(0, m.compaction.tokensBefore - m.compaction.tokensAfter) : 0;
  return (
    <div className="fade-in rounded-lumen-lg border border-dashed border-edge-strong bg-surface/60 px-3.5 py-2.5 text-[12.5px]">
      <button className="flex w-full items-center gap-2 text-left text-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="lucide:fold-vertical" size={14} />
        <span className="flex-1 font-medium">
          {m.compaction?.auto ? t('Verlauf automatisch kompaktiert') : t('Verlauf kompaktiert')}
          {count ? ` · ${count} ${t('Nachrichten zusammengefasst')}` : ''}
        </span>
        {saved > 0 && <span className="shrink-0 rounded-full bg-ok/15 px-2 py-0.5 text-[10.5px] text-ok">−{fmtTok(saved)} {t('Token')}</span>}
        <Icon name="lucide:chevron-right" size={12} className={cx('transition-transform duration-200', open && 'rotate-90')} />
      </button>
      <Collapse open={open}><div className="pt-2"><Markdown text={text} /></div></Collapse>
    </div>
  );
}

/** Markierung im Verlauf: ab hier antwortet ein anderer Anbieter, mit dem angegebenen übergebenen Kontext. */
function HandoffMark({ m }: { m: Message }) {
  if (!m.handoff || !m.provider) {
    return null;
  }
  return (
    <div className="flex items-center gap-3 pb-3 text-[11px] text-subtle" title={t('Der neue Anbieter hat den bisherigen Verlauf, die geänderten Dateien und die zuletzt ausgeführten Befehle als Kontext bekommen.')}>
      <span className="h-px flex-1 bg-edge" />
      <span className="flex items-center gap-1.5 rounded-full border border-edge bg-surface/70 px-2.5 py-1">
        <ProviderMark id={m.handoff.from} size={12} />
        <Icon name="lucide:arrow-right" size={11} />
        <ProviderMark id={m.provider} size={12} />
        <span className="text-muted">{t('Übergabe')}</span>
        <span>· {m.handoff.messages} {t('Nachrichten')} · ~{fmtTok(m.handoff.tokens)} {t('Token')}</span>
      </span>
      <span className="h-px flex-1 bg-edge" />
    </div>
  );
}

function fmtTok(n?: number) {
  if (n === undefined) return '';
  if (n >= 1_000_000_000) return `${Math.round(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export const MessageView = memo(function MessageView({ m, live, fresh, label, onStop, onOpenModel }: { m: Message; live?: boolean; /** Gerade eben selbst gesendet: bekommt die Sende-Animation. */ fresh?: boolean; label?: string; onStop?: () => void; onOpenModel?: (projectId: string) => void }) {
  if (m.role === 'user') {
    const text = m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('');
    return (
      <div className={cx(fresh ? 'msg-send' : 'fade-in', 'group/msg flex items-start justify-end gap-1')}>
        <CopyButton title={t('Kopieren / Copy')} className="mt-1 opacity-0 transition-opacity group-hover/msg:opacity-100" text={text} />
        <div className="min-w-0 max-w-[85%] select-text overflow-hidden rounded-2xl rounded-br-md border border-edge-strong/70 bg-surface px-4 py-2.5 shadow-[inset_0_1px_0_var(--c-sheen)]">
          {!!(m.images?.length || m.attachments?.length || m.files?.length) && <SentAttachments message={m} />}
          <div className="whitespace-pre-wrap text-[14px] leading-relaxed [overflow-wrap:anywhere]">{text}</div>
        </div>
      </div>
    );
  }
  if (m.role === 'system') return <CompactedSummary m={m} />;
  const lastIdx = m.blocks.length - 1;
  const cost = apiCost(m.usage, m.model, m.provider);
  const empty = !m.blocks.some((b) => b.kind !== 'tool');
  if (!live && empty && !m.error) return null;
  return (
    <div className={cx('fade-in group/asst', live && 'stream-live')}>
      {/* Volle Breite wie das Eingabefeld: Anbieter-Icon steht in der Kopfzeile statt in einer eigenen Spalte. */}
      <HandoffMark m={m} />
      <div className="min-w-0 space-y-2.5 [overflow-wrap:anywhere]">
        {(label || m.provider) && <div className="flex items-center gap-2 text-[11.5px] font-medium text-subtle">{m.provider && <ProviderMark id={m.provider} size={12} />}{label ?? PROVIDERS[m.provider!].name}</div>}
        {m.blocks.map((b, i) => {
          if (b.kind === 'text') return <Markdown key={i} text={b.text} />;
          if (b.kind === 'inject') return <div key={i} className="chip-in ml-auto w-fit max-w-[85%] select-text whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lumen border border-accent/30 bg-accent/10 px-3 py-1.5 text-[13px]"><span className="mr-2 text-[10.5px] font-medium uppercase tracking-wide text-accent">{t('Direkt')}</span>{b.text}</div>;
          if (b.kind === 'thinking') return <Thinking key={i} text={b.text} live={!!live && i === lastIdx} />;
          if (b.kind === 'model') return <button key={b.projectId} className="btn border border-edge bg-surface" onClick={() => onOpenModel?.(b.projectId)}><Icon name="lucide:cuboid" size={16} />{t('3D-Modell öffnen')}</button>;
          if (b.kind === 'image') return <GeneratedImage key={b.path} path={b.path} engine={b.engine} />;
          return null;
        })}
        {live && <ToolActivity live blocks={m.blocks} onStop={onStop} />}
        {m.error && <div className="shake flex gap-2 whitespace-pre-wrap rounded-lumen border border-bad/30 bg-bad/10 px-3 py-2 text-[12.5px] text-bad"><Icon name="lucide:triangle-alert" size={14} className="mt-0.5 shrink-0" /><span>{t(m.error)}</span></div>}
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
            {cost && <span title={t('Theoretische API-Kosten – so viel würde dieselbe Nutzung über die API kosten (Listenpreise, geschätzt).')}>≈ {fmtUsd(cost.usd)}</span>}
            {m.usage.durationMs !== undefined && <span>{(m.usage.durationMs / 1000).toFixed(1)}s</span>}
          </div>
        ) : null}
      </div>
    </div>
  );
});
