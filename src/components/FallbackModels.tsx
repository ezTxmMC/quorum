import { useState } from 'react';
import { PROVIDERS, PROVIDER_ORDER, canonicalModel, isChatModel, modelChoices, modelLabel } from '@shared/catalog';
import type { ChatLimit, FallbackModel, ProviderId } from '@shared/types';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { Dot, defaultModel, useModelLabel } from './ModelPicker';
import { Modal, cx } from './ui';

const DEFAULT_PERCENT = 80;

const WINDOWS: SegmentOption<ChatLimit['window']>[] = [
  { value: 'any', label: 'Egal welches' },
  { value: 'short', label: '5 h / Sitzung' },
  { value: 'weekly', label: 'Woche' },
];

const ACTIONS: SegmentOption<ChatLimit['action']>[] = [
  { value: 'fallback', label: 'Modell wechseln' },
  { value: 'stop', label: 'Chat stoppen' },
];

interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
}

function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="flex rounded-lumen-sm border border-edge bg-bg/60 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx('min-w-0 flex-1 truncate rounded-[5px] px-2.5 py-1 text-[12px] transition-colors', option.value === value ? 'bg-active font-medium text-fg' : 'text-muted hover:text-fg')}
        >
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}

interface StepProps {
  provider: ProviderId;
  model?: string;
  badge: string;
  caption: string;
  current?: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onRemove?: () => void;
}

/** Ein Glied der Kette: aktuelles Modell oder ein Ausweich-Modell. */
function Step({ provider, model, badge, caption, current, onUp, onDown, onRemove }: StepProps) {
  const label = useModelLabel(provider, model);
  return (
    <div className={cx('flex items-center gap-3 rounded-lumen border px-3 py-2.5', current ? 'border-accent/50 bg-accent/5' : 'border-edge bg-surface/60')}>
      <span className={cx('grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold', current ? 'bg-accent text-white' : 'bg-active text-muted')}>{badge}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] uppercase tracking-wide text-subtle">{caption}</div>
        <div className="flex items-center gap-1.5 truncate text-[13px] font-medium text-fg">
          <Dot id={provider} size={7} />
          <span className="truncate">{PROVIDERS[provider].name} · {label}</span>
        </div>
      </div>
      {onUp && <button className="icon-btn !size-6" title={t('Nach oben')} onClick={onUp}><Icon name="lucide:arrow-up" size={13} /></button>}
      {onDown && <button className="icon-btn !size-6" title={t('Nach unten')} onClick={onDown}><Icon name="lucide:arrow-down" size={13} /></button>}
      {onRemove && <button className="icon-btn !size-6" title={t('Entfernen')} onClick={onRemove}><Icon name="lucide:x" size={13} /></button>}
    </div>
  );
}

function Connector() {
  return (
    <div className="flex items-center gap-2 py-1 pl-[22px] text-[10.5px] text-subtle">
      <Icon name="lucide:arrow-down" size={12} />
      <span>{t('wenn das Limit erreicht ist')}</span>
    </div>
  );
}

function swap(list: FallbackModel[], a: number, b: number): FallbackModel[] {
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

interface FallbackPickerProps {
  /** Bereits in der Kette – werden als vergeben angezeigt statt doppelt wählbar zu sein. */
  taken: FallbackModel[];
  current?: { provider: ProviderId; model?: string };
  onPick: (provider: ProviderId, model: string) => void;
  onClose: () => void;
}

/** Auswahl eines Ausweich-Modells über die volle Breite: Suche, Anbieter als Filter und die Modelle als Raster. */
function FallbackPicker({ taken, current, onPick, onClose }: FallbackPickerProps) {
  const statuses = useHub((s) => s.statuses);
  const settings = useHub((s) => s.data.settings);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProviderId | 'all'>('all');
  const [older, setOlder] = useState(!!settings.showOlderModels);
  const needle = query.trim().toLowerCase();
  const currentModel = current ? canonicalModel(current.provider, current.model) ?? defaultModel(current.provider, statuses[current.provider]) : undefined;

  const groups = PROVIDER_ORDER.filter((provider) => statuses[provider]?.installed).map((provider) => ({
    provider,
    models: modelChoices(provider, statuses, settings.customModels?.[provider])
      .filter((model) => !model.image && isChatModel(model.id) && (older || !model.legacy))
      .filter((model) => !needle || `${PROVIDERS[provider].name} ${model.id} ${modelLabel(model)}`.toLowerCase().includes(needle)),
  })).filter((group) => group.models.length > 0);
  const shown = groups.filter((group) => filter === 'all' || group.provider === filter);
  const chipClass = (active: boolean) => cx('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors', active ? 'border-accent/60 bg-accent/10 text-fg' : 'border-edge text-muted hover:border-edge-strong hover:text-fg');

  return (
    <div className="rounded-lumen border border-accent/50 bg-surface/60">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <Icon name="lucide:search" size={14} className="shrink-0 text-subtle" />
        <input autoFocus aria-label={t('Modelle suchen')} placeholder={t('Ausweich-Modell suchen …')} value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent py-1 text-[13px] outline-none placeholder:text-subtle" />
        <button type="button" aria-pressed={older} className={chipClass(older)} onClick={() => setOlder(!older)}>
          <Icon name="lucide:history" size={12} /> {t('Ältere')}
        </button>
        <button className="icon-btn !size-6" title={t('Abbrechen')} onClick={onClose}><Icon name="lucide:x" size={13} /></button>
      </div>

      {groups.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-edge px-3 py-2">
          <button type="button" className={chipClass(filter === 'all')} onClick={() => setFilter('all')}>{t('Alle')}</button>
          {groups.map((group) => (
            <button key={group.provider} type="button" className={chipClass(filter === group.provider)} onClick={() => setFilter(group.provider)}>
              <Dot id={group.provider} size={7} /> {PROVIDERS[group.provider].name}
              <span className="text-subtle">{group.models.length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="max-h-72 space-y-3 overflow-y-auto p-3">
        {shown.length === 0 && <div className="py-4 text-center text-[12px] text-subtle">{t('Keine Modelle gefunden')}</div>}
        {shown.map((group) => (
          <div key={group.provider}>
            {filter === 'all' && (
              <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-subtle">
                <Dot id={group.provider} size={7} /> {PROVIDERS[group.provider].name}
              </div>
            )}
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {group.models.map((model) => {
                const isCurrent = current?.provider === group.provider && currentModel === model.id;
                const isTaken = taken.some((entry) => entry.provider === group.provider && entry.model === model.id);
                const note = isCurrent ? t('aktuelles Modell') : isTaken ? t('schon in der Kette') : model.legacy ? t('Älter') : '';
                return (
                  <button
                    key={model.id}
                    type="button"
                    disabled={isCurrent || isTaken}
                    title={model.id}
                    onClick={() => onPick(group.provider, model.id)}
                    className="flex min-w-0 items-center gap-2 rounded-lumen-sm border border-edge bg-bg/40 px-2.5 py-2 text-left transition-colors hover:border-accent/50 hover:bg-hover disabled:cursor-default disabled:opacity-45 disabled:hover:border-edge disabled:hover:bg-bg/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{modelLabel(model)}</span>
                    {note && <span className="shrink-0 text-[10.5px] text-subtle">{note}</span>}
                    {isTaken && <Icon name="lucide:check" size={12} className="shrink-0 text-accent" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface FallbackListProps {
  value: FallbackModel[];
  onChange: (value: FallbackModel[]) => void;
  /** Aktuelles Modell des Chats als Start der Kette (in den globalen Einstellungen gibt es keins). */
  current?: FallbackModel | { provider: ProviderId; model?: string };
}

/** Die Ausweich-Kette von oben nach unten: aktuelles Modell, dann die Ausweich-Modelle in ihrer Reihenfolge. */
export function FallbackList({ value, onChange, current }: FallbackListProps) {
  const [adding, setAdding] = useState(false);

  function handlePick(provider: ProviderId, id: string) {
    const model = canonicalModel(provider, id) ?? id;
    if (!value.some((entry) => entry.provider === provider && entry.model === model)) {
      onChange([...value, { provider, model }]);
    }
    setAdding(false);
  }

  return (
    <div>
      {current && <Step provider={current.provider} model={current.model} badge="★" caption={t('Aktuelles Modell')} current />}
      {value.map((entry, index) => (
        <div key={`${entry.provider}:${entry.model}`}>
          {(current || index > 0) && <Connector />}
          <Step
            provider={entry.provider}
            model={entry.model}
            badge={String(index + 1)}
            caption={`${index + 1}. ${t('Ausweich-Modell')}`}
            onUp={index > 0 ? () => onChange(swap(value, index, index - 1)) : undefined}
            onDown={index < value.length - 1 ? () => onChange(swap(value, index, index + 1)) : undefined}
            onRemove={() => onChange(value.filter((_, position) => position !== index))}
          />
        </div>
      ))}
      {(current || value.length > 0) && <Connector />}
      {adding ? (
        <FallbackPicker taken={value} current={current} onPick={handlePick} onClose={() => setAdding(false)} />
      ) : (
        <button className="flex w-full items-center justify-center gap-2 rounded-lumen border border-dashed border-edge-strong px-3 py-2.5 text-[12.5px] text-muted transition-colors hover:border-accent/60 hover:text-fg" onClick={() => setAdding(true)}>
          <Icon name="lucide:plus" size={14} /> {t('Ausweich-Modell hinzufügen')}
        </button>
      )}
    </div>
  );
}

interface SectionProps {
  step: string;
  title: string;
  children: React.ReactNode;
}

function Section({ step, title, children }: SectionProps) {
  return (
    <section className="space-y-2.5">
      <h4 className="flex items-center gap-2 text-[12.5px] font-semibold text-fg">
        <span className="grid size-5 place-items-center rounded-full bg-active text-[10.5px] text-muted">{step}</span>
        {title}
      </h4>
      {children}
    </section>
  );
}

interface ChoiceProps {
  selected: boolean;
  icon: string;
  title: string;
  hint: string;
  onSelect: () => void;
  children?: React.ReactNode;
}

function Choice({ selected, icon, title, hint, onSelect, children }: ChoiceProps) {
  return (
    <div className={cx('rounded-lumen border transition-colors', selected ? 'border-accent/60 bg-accent/5' : 'border-edge bg-surface/40 hover:border-edge-strong')}>
      <button type="button" aria-pressed={selected} className="flex w-full items-center gap-3 px-3 py-2.5 text-left" onClick={onSelect}>
        <Icon name={icon} size={16} className={cx('shrink-0', selected ? 'text-accent' : 'text-muted')} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium text-fg">{title}</span>
          <span className="block text-[11.5px] text-subtle">{hint}</span>
        </span>
        <span className={cx('grid size-4 shrink-0 place-items-center rounded-full border', selected ? 'border-accent' : 'border-edge-strong')}>
          {selected && <span className="size-2 rounded-full bg-accent" />}
        </span>
      </button>
      {selected && children && <div className="space-y-3 border-t border-edge/70 px-3 py-3">{children}</div>}
    </div>
  );
}

interface FallbackDialogProps {
  chatId: string;
  onClose: () => void;
}

/** Popup des Chats: Reihenfolge der Ausweich-Modelle, Geltungsbereich und ab wann gewechselt wird. */
function FallbackDialog({ chatId, onClose }: FallbackDialogProps) {
  const session = useHub((s) => s.data.sessions.find((x) => x.id === chatId));
  const global = useHub((s) => s.data.settings.fallbacks) ?? [];
  const { patchSession, setSettings } = useHub.getState();
  const list = session?.fallbacks ?? global;
  const first = list[0];
  const firstLabel = useModelLabel(first?.provider ?? 'claude', first?.model);

  if (!session) {
    return null;
  }

  const local = session.fallbacks !== undefined;
  const limit = session.limit;
  const meteredProvider = session.provider === 'claude' || session.provider === 'codex' || session.provider === 'antigravity';

  function setList(next: FallbackModel[]) {
    if (local) {
      patchSession(chatId, { fallbacks: next });
      return;
    }
    setSettings({ fallbacks: next });
  }

  function setLimit(next: ChatLimit | undefined) {
    patchSession(chatId, { limit: next });
  }

  const target = first ? `${PROVIDERS[first.provider].name} · ${firstLabel}` : '';
  const when = limit ? `${t('Ab')} ${limit.percent} % ${t('Verbrauch')}` : t('Sobald das Nutzungslimit erreicht ist,');
  const stops = limit?.action === 'stop';
  const outcome = stops ? t('stoppt dieser Chat.') : target ? `${t('macht dieser Chat weiter mit')} ${target}.` : t('passiert nichts – es ist kein Ausweich-Modell gewählt.');
  const missingTarget = !stops && !target;

  return (
    <Modal title={t('Ausweich-Modelle')} onClose={onClose}>
      <div className="space-y-5">
        <p className="text-[12.5px] text-muted">{t('Damit ein Chat nicht stehen bleibt: Ist das Kontingent eines Modells aufgebraucht, wechselt er automatisch zum nächsten Modell der Kette und wiederholt die letzte Anfrage.')}</p>

        <Section step="1" title={t('Reihenfolge')}>
          <Segmented
            value={local ? 'chat' : 'global'}
            options={[{ value: 'global', label: 'Für alle Chats' }, { value: 'chat', label: 'Nur dieser Chat' }]}
            onChange={(scope) => patchSession(chatId, { fallbacks: scope === 'chat' ? [...global] : undefined })}
          />
          <p className="text-[11.5px] text-subtle">{local ? t('Dieser Chat hat eine eigene Kette. Die Kette für alle anderen Chats bleibt unverändert.') : t('Diese Kette gilt für alle Chats ohne eigene Kette – Änderungen wirken überall.')}</p>
          <FallbackList value={list} onChange={setList} current={{ provider: session.provider, model: session.options.model }} />
        </Section>

        <Section step="2" title={t('Wann wechseln?')}>
          <Choice selected={!limit} icon="lucide:octagon-alert" title={t('Erst wenn das Limit erreicht ist')} hint={t('Der Anbieter meldet, dass das Kontingent aufgebraucht ist.')} onSelect={() => setLimit(undefined)} />
          <Choice
            selected={!!limit}
            icon="lucide:gauge"
            title={t('Schon vorher, ab einem Prozentwert')}
            hint={t('Nur dieser Chat. Hält Kontingent für andere Arbeit frei.')}
            onSelect={() => !limit && setLimit({ window: 'any', percent: DEFAULT_PERCENT, action: list.length ? 'fallback' : 'stop' })}
          >
            {limit && (
              <>
                <div>
                  <div className="mb-1 flex items-baseline justify-between text-[11.5px] text-muted">
                    <span>{t('Verbrauch')}</span>
                    <span className="text-[15px] font-semibold tabular-nums text-fg">{limit.percent} %</span>
                  </div>
                  <input type="range" min={5} max={100} step={5} value={limit.percent} onChange={(event) => setLimit({ ...limit, percent: Number(event.target.value) })} className="w-full accent-[var(--c-accent)]" />
                </div>
                <div>
                  <div className="mb-1 text-[11.5px] text-muted">{t('Welches Limit zählt?')}</div>
                  <Segmented value={limit.window} options={WINDOWS} onChange={(window) => setLimit({ ...limit, window })} />
                </div>
                <div>
                  <div className="mb-1 text-[11.5px] text-muted">{t('Was dann passiert')}</div>
                  <Segmented value={limit.action} options={ACTIONS} onChange={(action) => setLimit({ ...limit, action })} />
                </div>
                {!meteredProvider && <p className="text-[11.5px] text-warn">{t('Für diesen Anbieter gibt es keine Verbrauchswerte – der Prozentwert greift nur bei Claude, Codex und Antigravity.')}</p>}
              </>
            )}
          </Choice>
        </Section>

        <div className={cx('flex items-start gap-2.5 rounded-lumen border px-3 py-2.5 text-[12.5px]', missingTarget ? 'border-warn/30 bg-warn/10 text-warn' : 'border-edge bg-bg/50 text-fg')}>
          <Icon name={missingTarget ? 'lucide:triangle-alert' : 'lucide:info'} size={14} className="mt-0.5 shrink-0" />
          <span>{when} {outcome}</span>
        </div>
      </div>
    </Modal>
  );
}

interface FallbackButtonProps {
  chatId: string;
}

/** Titelleisten-Knopf des Chats; zeigt an, wie viele Ausweich-Modelle bereitstehen und ob ein Prozent-Limit gesetzt ist. */
export function FallbackButton({ chatId }: FallbackButtonProps) {
  const [open, setOpen] = useState(false);
  const count = useHub((s) => (s.data.sessions.find((x) => x.id === chatId)?.fallbacks ?? s.data.settings.fallbacks ?? []).length);
  const percent = useHub((s) => s.data.sessions.find((x) => x.id === chatId)?.limit?.percent);
  const configured = count > 0 || percent !== undefined;
  const detail = [count > 0 ? `${count} ${t('bereit')}` : t('keine gewählt'), percent !== undefined ? `${t('ab')} ${percent} %` : ''].filter(Boolean).join(' · ');

  return (
    <>
      <button className={cx('icon-btn relative !size-8', (open || configured) && 'text-fg', open && 'bg-active')} title={`${t('Ausweich-Modelle')} (${detail})`} onClick={() => setOpen(true)}>
        <Icon name="lucide:life-buoy" size={15} />
        {configured && <span className="absolute right-0.5 top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent px-[3px] text-[9px] font-semibold leading-none text-white">{count || '%'}</span>}
      </button>
      {open && <FallbackDialog chatId={chatId} onClose={() => setOpen(false)} />}
    </>
  );
}
