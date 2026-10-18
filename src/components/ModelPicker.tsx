import { t } from '@/lib/i18n';
import { PROVIDERS, EFFORT_LABELS, MODES, currentMode, imageEngineLabel, imageEngines, modePatch, modesFor } from '@shared/catalog';
import type { ProviderId, ProviderOptions } from '@shared/types';
import type { ReactNode } from 'react';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { Popover, cx } from './ui';

const ORDER: ProviderId[] = ['claude', 'codex', 'antigravity', 'opencode', 'ollama', 'local'];

export function Dot({ id, size = 8 }: { id: ProviderId; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: PROVIDERS[id].color, boxShadow: `0 0 0 3px color-mix(in srgb, ${PROVIDERS[id].color} 22%, transparent)` }} />;
}

/** Anzeigename des aktuellen Modells (ohne Anbieter-Namen). */
export function useModelLabel(provider: ProviderId, model?: string): string {
  const status = useHub((s) => s.statuses[provider]);
  if (!model) return status?.models[0]?.label ?? '…';
  return status?.models.find((m) => m.id === model)?.label ?? model;
}

export function defaultModel(provider: ProviderId, status?: { models: { id: string }[] }): string | undefined {
  return provider === 'claude' ? 'sonnet' : status?.models[0]?.id;
}

export function ModelList({ provider, model, onPick }: { provider?: ProviderId; model?: string; onPick: (p: ProviderId, model: string) => void }) {
  const statuses = useHub((s) => s.statuses);
  return (
    <div className="max-h-96 w-72 overflow-auto">
      {ORDER.filter((p) => statuses[p]?.installed || p === provider).map((p) => {
        const st = statuses[p];
        return (
          <div key={p}>
            <div className="flex items-center gap-2 px-2.5 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-subtle"><Dot id={p} size={6} />{PROVIDERS[p].vendor}</div>
            {st?.installed === false && <div className="px-2.5 pb-1 text-[11.5px] text-subtle">{p === 'ollama' ? t('Ollama läuft nicht (ollama serve)') : t('nicht installiert')}</div>}
            {st?.models.map((m) => {
              const active = p === provider && (model ?? defaultModel(p, st)) === m.id;
              return (
                <button key={m.id} className={cx('flex w-full items-center gap-2.5 rounded-lumen-sm px-2.5 py-1.5 text-left transition-colors hover:bg-hover', active && 'bg-active')} onClick={() => onPick(p, m.id)}>
                  <span className="flex-1 truncate text-[12.5px]">{m.label}</span>
                  {active && <Icon name="lucide:check" size={14} className="text-accent" />}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function ModelButton({ provider, model, onPick, down, compact }: { provider: ProviderId; model?: string; onPick: (p: ProviderId, model: string) => void; down?: boolean; compact?: boolean }) {
  const label = useModelLabel(provider, model);
  return (
    <Popover down={down} trigger={(open, tg) => (
      <button className={cx('btn btn-ghost !gap-2 !px-2 text-fg', open && '!bg-hover', compact && '!py-1')} onClick={tg}>
        <Dot id={provider} /> <span className="max-w-48 truncate text-[12.5px]">{label}</span>
        <Icon name="lucide:chevron-down" size={12} className={cx('text-subtle transition-transform', open && 'rotate-180')} />
      </button>
    )}>
      {(close) => <ModelList provider={provider} model={model} onPick={(p, m) => { onPick(p, m); close(); }} />}
    </Popover>
  );
}

export function EffortButton({ provider, model, value, onChange, down }: { provider: ProviderId; model?: string; value?: string; onChange: (v: string | undefined) => void; down?: boolean }) {
  const status = useHub((s) => s.statuses[provider]);
  const info = status?.models.find((m) => m.id === (model ?? defaultModel(provider, status)));
  const efforts = info?.efforts ?? PROVIDERS[provider].efforts.map((e) => e.value);
  return (
    <Popover down={down} trigger={(open, tg) => (
      <button className={cx('btn btn-ghost !gap-1.5 !px-2 text-muted', open && '!bg-hover')} onClick={tg} title={t('Denktiefe / Reasoning-Effort')}>
        <Icon name="lucide:brain" size={14} /> <span className="text-[12px]">{value ? t(EFFORT_LABELS[value] ?? value) : t('Auto')}</span>
        <Icon name="lucide:chevron-down" size={12} className={cx('text-subtle transition-transform', open && 'rotate-180')} />
      </button>
    )}>
      {(close) => (
        <div className="w-44">
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Denktiefe')}</div>
          {[undefined, ...efforts].map((e) => (
            <button key={e ?? 'auto'} className={cx('flex w-full items-center rounded-lumen-sm px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover', value === e && 'bg-active')} onClick={() => { onChange(e); close(); }}>
              <span className="flex-1">{e ? t(EFFORT_LABELS[e] ?? e) : t('Auto')}</span>
              {value === e && <Icon name="lucide:check" size={14} className="text-accent" />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

export function SpeedButton({ provider, model, value, onChange, down }: { provider: ProviderId; model?: string; value?: string; onChange: (v: string | undefined) => void; down?: boolean }) {
  const status = useHub((s) => s.statuses[provider]);
  const info = status?.models.find((m) => m.id === (model ?? defaultModel(provider, status)));
  const tiers = info?.speedTiers;
  if (!tiers?.length) return null;
  const cur = tiers.find((x) => x.id === value);
  return (
    <Popover down={down} trigger={(open, tg) => (
      <button className={cx('btn btn-ghost !gap-1.5 !px-2', cur ? 'text-warn' : 'text-muted', open && '!bg-hover')} onClick={tg} title={t('Geschwindigkeit')}>
        <Icon name="lucide:gauge" size={14} /> <span className="text-[12px]">{cur ? cur.name : t('Standard')}</span>
        <Icon name="lucide:chevron-down" size={12} className={cx('text-subtle transition-transform', open && 'rotate-180')} />
      </button>
    )}>
      {(close) => (
        <div className="w-64">
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Geschwindigkeit')}</div>
          {[{ id: undefined, name: t('Standard'), description: t('Normale Geschwindigkeit') }, ...tiers.map((x) => ({ ...x, description: t('Schnellere Antworten, höherer Verbrauch') }))].map((x) => (
            <button key={x.id ?? 'std'} className={cx('flex w-full items-center gap-2 rounded-lumen-sm px-2.5 py-1.5 text-left hover:bg-hover', value === x.id && 'bg-active')} onClick={() => { onChange(x.id); close(); }}>
              <span className="min-w-0 flex-1"><span className="block text-[12.5px]">{x.name}</span><span className="block truncate text-[11px] text-subtle">{x.description}</span></span>
              {value === x.id && <Icon name="lucide:check" size={14} className="text-accent" />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** Berechtigungsmodus des Chats (Fragen, Bearbeiten, Plan, Auto, Nicht fragen, Vollzugriff) – gilt pro Chat. */
export function ModeButton({ provider, options, onChange, onMore }: { provider: ProviderId; options: ProviderOptions; onChange: (patch: ProviderOptions) => void; onMore?: () => void }) {
  const ids = modesFor(provider);
  if (!ids.length) return null;
  const cur = currentMode(provider, options);
  const meta = MODES.find((m) => m.id === cur)!;
  return (
    <Popover trigger={(open, tg) => (
      <button className={cx('btn btn-ghost !gap-1.5 !px-2', cur === 'full' ? 'text-bad' : 'text-muted', open && '!bg-hover')} onClick={tg} title={t(meta.hint)}>
        <Icon name={meta.icon} size={14} /> <span className="text-[12px]">{t(meta.label)}</span>
        <Icon name="lucide:chevron-down" size={12} className={cx('text-subtle transition-transform', open && 'rotate-180')} />
      </button>
    )}>
      {(close) => (
        <div className="w-72">
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Berechtigungen für diesen Chat')}</div>
          {MODES.filter((m) => ids.includes(m.id)).map((m) => (
            <button key={m.id} className={cx('flex w-full items-start gap-2.5 rounded-lumen-sm px-2.5 py-1.5 text-left transition-colors hover:bg-hover', cur === m.id && 'bg-active')} onClick={() => { onChange(modePatch(provider, m.id)); close(); }}>
              <Icon name={m.icon} size={15} className={cx('mt-0.5 shrink-0', m.id === 'full' ? 'text-bad' : 'text-muted')} />
              <span className="min-w-0 flex-1"><span className="block text-[12.5px]">{t(m.label)}</span><span className="block text-[11px] text-subtle">{t(m.hint)}</span></span>
              {cur === m.id && <Icon name="lucide:check" size={14} className="mt-0.5 shrink-0 text-accent" />}
            </button>
          ))}
          {onMore && (<><div className="my-1 border-t border-edge" /><button className="flex w-full items-center gap-2 rounded-lumen-sm px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-hover hover:text-fg" onClick={() => { onMore(); close(); }}><Icon name="lucide:sliders-horizontal" size={14} /> {t('Weitere CLI-Optionen …')}</button></>)}
        </div>
      )}
    </Popover>
  );
}

export function UltracodeButton({ value, onChange }: { value?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={cx('btn btn-ghost !gap-1.5 !px-2 transition-colors', value ? '!bg-accent/15 text-accent' : 'text-muted')} onClick={() => onChange(!value)} title={t('Ultracode: Claude Code orchestriert selbst mehrere Agenten')}>
      <Icon name="lucide:rocket" size={14} /> <span className="text-[12px]">Ultracode</span>
    </button>
  );
}

/** Denktiefe, Geschwindigkeit und Ultracode in einem Regler – nur die Abschnitte, die Anbieter/Modell unterstützen. */
export function TuneButton({ provider, options, onChange }: { provider: ProviderId; options: ProviderOptions; onChange: (patch: ProviderOptions) => void }) {
  const status = useHub((s) => s.statuses[provider]);
  const info = status?.models.find((m) => m.id === (options.model ?? defaultModel(provider, status)));
  const efforts = PROVIDERS[provider].efforts.length ? (info?.efforts ?? PROVIDERS[provider].efforts.map((e) => e.value)) : [];
  const tiers = info?.speedTiers ?? [];
  const ultra = provider === 'claude';
  if (!efforts.length && !tiers.length && !ultra) return null;
  const tier = tiers.find((x) => x.id === options.speed);
  const parts = [efforts.length ? (options.effort ? t(EFFORT_LABELS[options.effort] ?? options.effort) : t('Auto')) : null, tier?.name, ultra && options.ultracode ? 'Ultracode' : null].filter(Boolean);
  const hot = !!tier || (ultra && !!options.ultracode);
  const Head = ({ children }: { children: string }) => <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{children}</div>;
  const Row = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) => (
    <button className={cx('flex w-full items-center gap-2 rounded-lumen-sm px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover', active && 'bg-active')} onClick={onClick}>
      <span className="min-w-0 flex-1">{children}</span>{active && <Icon name="lucide:check" size={14} className="text-accent" />}
    </button>
  );
  return (
    <Popover trigger={(open, tg) => (
      <button className={cx('btn btn-ghost !gap-1.5 !px-2', hot ? 'text-accent' : 'text-muted', open && '!bg-hover')} onClick={tg} title={t('Denktiefe, Geschwindigkeit & Ultracode')}>
        <Icon name={ultra && options.ultracode ? 'lucide:rocket' : 'lucide:brain'} size={14} /> <span className="max-w-44 truncate text-[12px]">{parts.join(' · ') || t('Auto')}</span>
        <Icon name="lucide:chevron-down" size={12} className={cx('text-subtle transition-transform', open && 'rotate-180')} />
      </button>
    )}>
      {() => (
        <div className="w-64">
          {efforts.length > 0 && (<>
            <Head>{t('Denktiefe')}</Head>
            {[undefined, ...efforts].map((e) => <Row key={e ?? 'auto'} active={options.effort === e} onClick={() => onChange({ effort: e })}>{e ? t(EFFORT_LABELS[e] ?? e) : t('Auto')}</Row>)}
          </>)}
          {tiers.length > 0 && (<>
            {efforts.length > 0 && <div className="my-1 border-t border-edge" />}
            <Head>{t('Geschwindigkeit')}</Head>
            {[{ id: undefined as string | undefined, name: t('Standard') }, ...tiers].map((x) => <Row key={x.id ?? 'std'} active={options.speed === x.id} onClick={() => onChange({ speed: x.id })}>{x.name}</Row>)}
          </>)}
          {ultra && (<>
            <div className="my-1 border-t border-edge" />
            <button className="flex w-full items-center gap-2.5 rounded-lumen-sm px-2.5 py-2 text-left transition-colors hover:bg-hover" onClick={() => onChange({ ultracode: !options.ultracode })}>
              <Icon name="lucide:rocket" size={15} className={options.ultracode ? 'text-accent' : 'text-muted'} />
              <span className="min-w-0 flex-1"><span className="block text-[12.5px]">Ultracode</span><span className="block text-[11px] text-subtle">{t('Ultracode: Claude Code orchestriert selbst mehrere Agenten')}</span></span>
              <span className={cx('relative h-[18px] w-8 shrink-0 rounded-full transition-colors', options.ultracode ? 'bg-accent' : 'bg-edge')}>
                <span className={cx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-[left] duration-200', options.ultracode ? 'left-[16px]' : 'left-[2px]')} />
              </span>
            </button>
          </>)}
        </div>
      )}
    </Popover>
  );
}

/** Bildmodus wie im ChatGPT-/Gemini-Chat: Nachrichten erzeugen Bilder mit der gewählten Engine – in jedem Chat, egal welches Modell. */
export function ImageButton({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const statuses = useHub((s) => s.statuses);
  const engines = imageEngines(statuses);
  if (!engines.length && !value) return null;
  return (
    <Popover trigger={(open, tg) => (
      <button className={cx('btn btn-ghost !gap-1.5 !px-2 transition-colors', value ? '!bg-accent/15 text-accent' : 'text-muted', open && !value && '!bg-hover')} onClick={tg} title={t('Bild erzeugen')}>
        <Icon name="lucide:image-plus" size={14} /> {value ? <span className="text-[12px]">{imageEngineLabel(value)}</span> : <span className="text-[12px]">{t('Bild')}</span>}
      </button>
    )}>
      {(close) => (
        <div className="w-72">
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Bild erzeugen')}</div>
          {engines.map((e) => (
            <button key={e.id} className={cx('flex w-full items-start gap-2.5 rounded-lumen-sm px-2.5 py-1.5 text-left transition-colors hover:bg-hover', value === e.id && 'bg-active')} onClick={() => { onChange(e.id); close(); }}>
              <Dot id={e.provider} size={7} />
              <span className="-mt-1 min-w-0 flex-1"><span className="block text-[12.5px]">{e.label} <span className="text-[11px] text-subtle">· {e.via}</span></span><span className="block text-[11px] text-subtle">{t(e.hint)}</span></span>
              {value === e.id && <Icon name="lucide:check" size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
          {value && (<><div className="my-1 border-t border-edge" /><button className="flex w-full items-center gap-2 rounded-lumen-sm px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-hover hover:text-fg" onClick={() => { onChange(undefined); close(); }}><Icon name="lucide:message-square" size={14} /> {t('Zurück zum Chat (Bildmodus aus)')}</button></>)}
        </div>
      )}
    </Popover>
  );
}

export type PickPatch = { provider: ProviderId; options: ProviderOptions };
