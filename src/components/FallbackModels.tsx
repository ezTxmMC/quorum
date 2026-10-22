import { useState } from 'react';
import { PROVIDERS, canonicalModel } from '@shared/catalog';
import type { ChatLimit, ChatSession, FallbackModel, ProviderId } from '@shared/types';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { Dot, ModelList, useModelLabel } from './ModelPicker';
import { Popover, Select, cx } from './ui';

function Row({ provider, model, index, onRemove, onUp }: { provider: ProviderId; model: string; index: number; onRemove: () => void; onUp?: () => void }) {
  const label = useModelLabel(provider, model);
  return (
    <div className="flex items-center gap-2 rounded-lumen-sm px-2 py-1.5 hover:bg-hover">
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-active text-[10px] text-muted">{index + 1}</span>
      <Dot id={provider} size={7} />
      <span className="min-w-0 flex-1 truncate text-[12.5px]" title={`${PROVIDERS[provider].name} · ${model}`}>{PROVIDERS[provider].name} · {label}</span>
      {onUp && <button className="icon-btn !size-5" title={t('Nach oben')} onClick={onUp}><Icon name="lucide:arrow-up" size={12} /></button>}
      <button className="icon-btn !size-5" title={t('Entfernen')} onClick={onRemove}><Icon name="lucide:x" size={12} /></button>
    </div>
  );
}

/** Geordnete Liste von Ausweich-Modellen mit Hinzufügen, Entfernen und Umsortieren. */
export function FallbackList({ value, onChange }: { value: FallbackModel[]; onChange: (v: FallbackModel[]) => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <div>
      {value.map((f, i) => (
        <Row key={`${f.provider}:${f.model}`} provider={f.provider} model={f.model} index={i}
          onUp={i > 0 ? () => onChange(value.map((x, j) => (j === i - 1 ? value[i] : j === i ? value[i - 1] : x))) : undefined}
          onRemove={() => onChange(value.filter((_, j) => j !== i))} />
      ))}
      {!value.length && !adding && <div className="px-2 py-1.5 text-[12px] text-subtle">{t('Keine Ausweich-Modelle gewählt.')}</div>}
      {adding
        ? <div className="mt-1 rounded-lumen border border-edge"><ModelList kind="text" onPick={(p, id) => {
          const model = canonicalModel(p, id) ?? id;
          if (!value.some((f) => f.provider === p && f.model === model)) onChange([...value, { provider: p, model }]);
          setAdding(false);
        }} /></div>
        : <button className="btn btn-ghost mt-1 w-full !justify-start !px-2 text-muted" onClick={() => setAdding(true)}><Icon name="lucide:plus" size={14} /> {t('Modell hinzufügen')}</button>}
    </div>
  );
}

const WINDOWS: { value: ChatLimit['window']; label: string }[] = [
  { value: 'any', label: 'Beliebiges Fenster (höchster Wert)' },
  { value: 'short', label: '5-Stunden- / Sitzungslimit' },
  { value: 'weekly', label: 'Wochenlimit' },
];

/** Fallback & Limit des Chats: Ausweich-Modelle (global oder nur für diesen Chat) und ein Prozent-Limit mit Aktion. */
export function FallbackButton({ session }: { session: Pick<ChatSession, 'id' | 'provider' | 'fallbacks' | 'limit'> }) {
  const patch = useHub((s) => s.patchSession);
  const global = useHub((s) => s.data.settings.fallbacks) ?? [];
  const { openSettings } = useHub.getState();
  const local = session.fallbacks !== undefined;
  const list = session.fallbacks ?? global;
  const limit = session.limit;
  const setLimit = (next: ChatLimit | undefined) => patch(session.id, { limit: next });
  return (
    <Popover align="right" trigger={(open, toggle) => (
      <button onClick={toggle} title={t('Fallback & Limit')} className={cx('btn btn-ghost !gap-1 !px-2 text-subtle', (open || list.length > 0 || limit) && '!text-fg', open && '!bg-hover')}>
        <Icon name="lucide:life-buoy" size={14} />{list.length > 0 && <span className="text-[10.5px]">{list.length}</span>}
        {limit && <span className="text-[10.5px] text-accent">{limit.percent}%</span>}
      </button>
    )}>
      {() => (
        <div className="w-80 max-w-[calc(100vw-3rem)] p-1">
          <div className="flex items-center gap-2 px-2 pb-1 pt-1.5">
            <span className="flex-1 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Ausweich-Modelle')} · {local ? t('nur dieser Chat') : t('global')}</span>
            {local
              ? <button className="text-[11px] text-accent hover:underline" onClick={() => patch(session.id, { fallbacks: undefined })}>{t('Global verwenden')}</button>
              : <button className="text-[11px] text-accent hover:underline" onClick={() => openSettings('general')}>{t('Global bearbeiten')}</button>}
          </div>
          <p className="px-2 pb-2 text-[11.5px] text-subtle">{t('Wird das Nutzungslimit erreicht, wechselt der Chat zum ersten Modell der Liste und wiederholt die letzte Anfrage.')}</p>
          <FallbackList value={list} onChange={(v) => patch(session.id, { fallbacks: v })} />

          <div className="mt-2 border-t border-edge px-2 pb-2 pt-2.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="flex-1 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Prozent-Limit dieses Chats')}</span>
              <button type="button" aria-pressed={!!limit} onClick={() => setLimit(limit ? undefined : { window: 'any', percent: 80, action: list.length ? 'fallback' : 'stop' })}
                className={cx('relative h-[18px] w-8 shrink-0 rounded-full transition-colors', limit ? 'bg-accent' : 'bg-active')}>
                <span className={cx('absolute top-[2px] size-[14px] rounded-full bg-white transition-all', limit ? 'left-[16px]' : 'left-[2px]')} />
              </button>
            </div>
            {limit ? (
              <div className="space-y-2">
                <Select value={limit.window} onChange={(window) => setLimit({ ...limit, window })} options={WINDOWS.map((w) => ({ value: w.value, label: t(w.label) }))} />
                <div className="flex items-center gap-2">
                  <input type="range" min={5} max={100} step={5} value={limit.percent} onChange={(e) => setLimit({ ...limit, percent: Number(e.target.value) })} className="min-w-0 flex-1 accent-[var(--c-accent)]" />
                  <span className="w-10 shrink-0 text-right text-[12px] tabular-nums">{limit.percent}%</span>
                </div>
                <Select value={limit.action} onChange={(action) => setLimit({ ...limit, action })} options={[{ value: 'fallback', label: t('Dann: zum Ausweich-Modell wechseln') }, { value: 'stop', label: t('Dann: Chat stoppen') }]} />
                <p className="text-[11px] text-subtle">{t('Gilt für Claude, Codex und Antigravity (Werte aus der Nutzungsanzeige). Geprüft wird vor jeder neuen Nachricht.')}</p>
              </div>
            ) : <p className="text-[11.5px] text-subtle">{t('Kein Limit gesetzt.')}</p>}
          </div>
        </div>
      )}
    </Popover>
  );
}
