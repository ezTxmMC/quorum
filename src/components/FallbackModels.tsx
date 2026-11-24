import { useState } from 'react';
import { PROVIDERS, canonicalModel } from '@shared/catalog';
import type { ChatLimit, FallbackModel, ProviderId } from '@shared/types';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { Dot, ModelList, useModelLabel } from './ModelPicker';
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
        <div className="rounded-lumen border border-accent/50 bg-surface/60">
          <div className="flex items-center justify-between border-b border-edge px-3 py-1.5 text-[11.5px] text-muted">
            <span>{t('Ausweich-Modell wählen')}</span>
            <button className="icon-btn !size-5" title={t('Abbrechen')} onClick={() => setAdding(false)}><Icon name="lucide:x" size={12} /></button>
          </div>
          <ModelList kind="text" onPick={handlePick} />
        </div>
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
