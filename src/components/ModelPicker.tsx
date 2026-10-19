import { t } from '@/lib/i18n';
import { PROVIDERS, MODES, currentMode, imageEngineLabel, canonicalModel, modelChoices, modePatch, modesFor, modeLabel, modelLabel, modelEfforts, effortLabel, isChatModel } from '@shared/catalog';
import type { ModelInfo, ProviderId, ProviderOptions } from '@shared/types';
import { useState, type ReactNode } from 'react';
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
  model = canonicalModel(provider, model);
  if (!model) model = defaultModel(provider, status);
  if (!model) return '…';
  const info = modelChoices(provider, { [provider]: status }).find((m) => m.id === model);
  return modelLabel(info ?? { id: model, label: model });
}

export function defaultModel(provider: ProviderId, status?: { models: { id: string }[] }): string | undefined {
  return provider === 'claude' ? 'claude-sonnet-5-5' : status?.models[0]?.id;
}

export function ModelList({ provider, model, imageGen, onPick, includeImages, onlyProvider }: { provider?: ProviderId; model?: string; imageGen?: string; onPick: (p: ProviderId, model: string, imageGen?: string) => void; includeImages?: boolean; onlyProvider?: ProviderId }) {
  const statuses = useHub((s) => s.statuses);
  const settings = useHub((s) => s.data.settings);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ProviderId | undefined>(onlyProvider ?? provider);
  const [older, setOlder] = useState(!!settings.showOlderModels);
  const q = query.trim().toLowerCase();
  const selected = imageGen ? `image:${imageGen}` : canonicalModel(provider ?? 'claude', model);
  const groups = ORDER.filter((p) => (!onlyProvider || p === onlyProvider) && (statuses[p]?.installed || p === provider)).map((p) => {
    const models = modelChoices(p, statuses, settings.customModels?.[p], includeImages).filter((m) => isChatModel(m.id) && (older || !m.legacy || (p === provider && m.id === selected)) && (!q || `${PROVIDERS[p].name} ${m.id} ${modelLabel(m)}`.toLowerCase().includes(q)));
    return { p, models };
  }).filter((g) => g.models.length || !q);
  return (
    <div className="w-80 max-w-[calc(100vw-3rem)]">
      <div className="border-b border-edge p-1.5">
        <input aria-label={t('Modelle suchen')} className="field !text-[12px]" placeholder={t('Modelle suchen …')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="mt-2 flex items-center gap-2 text-[11.5px] text-muted"><input type="checkbox" checked={older} onChange={(e) => setOlder(e.target.checked)} />{t('Ältere Modelle anzeigen')}</label>
      </div>
      <div className="max-h-[min(24rem,50vh)] overflow-y-auto py-1">
        {groups.map(({ p, models }) => {
          const open = !!onlyProvider || !!q || expanded === p;
          const subgroups = new Map<string, ModelInfo[]>();
          for (const m of models) { const key = m.group ?? ''; subgroups.set(key, [...(subgroups.get(key) ?? []), m]); }
          return <div key={p}>
            <button aria-expanded={open} disabled={!!onlyProvider} className="flex w-full items-center gap-2 rounded-lumen-sm px-2.5 py-2 text-left hover:bg-hover" onClick={() => setExpanded(open ? undefined : p)}>
              <Dot id={p} size={7} /><span className="flex-1 text-[12px] font-medium">{PROVIDERS[p].name}</span><span className="text-[10px] text-subtle">{models.length}</span>{!onlyProvider && <Icon name={open ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={13} />}
            </button>
            {open && [...subgroups].map(([group, list]) => <div key={group}>
              {group && <div className="px-5 py-1 text-[10px] uppercase tracking-wide text-subtle">{group === 'opencode' ? 'OpenCode Zen' : group === 'Custom' ? t('Eigene Modelle') : group}</div>}
              {list.map((m) => {
                const active = p === provider && (selected ?? defaultModel(p, statuses[p])) === m.id;
                return <button key={m.id} title={m.id} className={cx('flex w-full items-center gap-2 rounded-lumen-sm py-1.5 pl-5 pr-2.5 text-left hover:bg-hover', active && 'bg-active')} onClick={() => onPick(p, m.id, m.imageEngine)}>
                  <Icon name={m.image ? 'lucide:image' : 'lucide:message-square'} size={13} className="shrink-0 text-subtle" /><span className="min-w-0 flex-1 truncate text-[12.5px]">{modelLabel(m)}</span>{m.legacy && <span className="text-[10px] text-subtle">{t('Älter')}</span>}{active && <Icon name="lucide:check" size={14} className="text-accent" />}
                </button>;
              })}
              {!list.length && <div className="px-5 py-2 text-[12px] text-subtle">{t('Keine Modelle verfügbar')}</div>}
            </div>)}
          </div>;
        })}
        {!groups.length && <div className="p-3 text-[12px] text-subtle">{t('Keine Modelle gefunden')}</div>}
      </div>
    </div>
  );
}

interface ModelButtonProps {
  provider: ProviderId;
  model?: string;
  imageGen?: string;
  includeImages?: boolean;
  onlyProvider?: ProviderId;
  field?: boolean;
  down?: boolean;
  compact?: boolean;
  onPick: (provider: ProviderId, model: string, imageGen?: string) => void;
}

export function ModelButton({ provider, model, imageGen, onPick, down, compact, includeImages, onlyProvider, field }: ModelButtonProps) {
  const textLabel = useModelLabel(provider, model);
  const label = imageGen ? imageEngineLabel(imageGen) : textLabel;
  return (
    <Popover down={down} trigger={(open, toggle) => (
      <button className={cx(field ? 'field flex w-full items-center gap-2 text-left' : 'btn btn-ghost !gap-2 !px-2 text-muted', open && '!bg-hover', !field && compact && '!py-1')} onClick={toggle} aria-expanded={open} aria-label={`${t('Modell')}: ${label}`}>
        <Dot id={provider} size={7} /><span className={cx('min-w-0 truncate text-[12.5px]', field ? 'flex-1' : 'max-w-48')}>{label}</span>
        {imageGen && <Icon name="lucide:image" size={13} className="shrink-0 text-subtle" />}
        <Icon name="lucide:chevron-down" size={12} className={cx('shrink-0 text-subtle transition-transform', open && 'rotate-180')} />
      </button>
    )}>
      {(close) => <ModelList provider={provider} model={model} imageGen={imageGen} includeImages={includeImages} onlyProvider={onlyProvider} onPick={(p, id, engine) => { onPick(p, id, engine); close(); }} />}
    </Popover>
  );
}

export function EffortButton({ provider, model, value, onChange, down }: { provider: ProviderId; model?: string; value?: string; onChange: (v: string | undefined) => void; down?: boolean }) {
  const status = useHub((s) => s.statuses[provider]);
  const info = modelChoices(provider, { [provider]: status }).find((m) => m.id === (canonicalModel(provider, model) ?? defaultModel(provider, status)));
  const efforts = modelEfforts(provider, info);
  return (
    <Popover down={down} trigger={(open, tg) => (
      <button className={cx('btn btn-ghost !gap-1.5 !px-2 text-muted', open && '!bg-hover')} onClick={tg} title={t('Denktiefe / Reasoning-Effort')}>
        <Icon name="lucide:brain" size={14} /> <span className="text-[12px]">{value ? t(effortLabel(provider, value)) : t('Auto')}</span>
        <Icon name="lucide:chevron-down" size={12} className={cx('text-subtle transition-transform', open && 'rotate-180')} />
      </button>
    )}>
      {(close) => (
        <div className="w-44">
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Denktiefe')}</div>
          {[undefined, ...efforts].map((e) => (
            <button key={e ?? 'auto'} className={cx('flex w-full items-center rounded-lumen-sm px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover', value === e && 'bg-active')} onClick={() => { onChange(e); close(); }}>
              <span className="flex-1">{e ? t(effortLabel(provider, e)) : t('Auto')}</span>
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
  const info = modelChoices(provider, { [provider]: status }).find((m) => m.id === (canonicalModel(provider, model) ?? defaultModel(provider, status)));
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
        <Icon name={meta.icon} size={14} /> <span className="text-[12px]">{t(modeLabel(provider, cur))}</span>
        <Icon name="lucide:chevron-down" size={12} className={cx('text-subtle transition-transform', open && 'rotate-180')} />
      </button>
    )}>
      {(close) => (
        <div className="w-72">
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Berechtigungen für diesen Chat')}</div>
          {MODES.filter((m) => ids.includes(m.id)).map((m) => (
            <button key={m.id} className={cx('flex w-full items-start gap-2.5 rounded-lumen-sm px-2.5 py-1.5 text-left transition-colors hover:bg-hover', cur === m.id && 'bg-active')} onClick={() => { onChange(modePatch(provider, m.id)); close(); }}>
              <Icon name={m.icon} size={15} className={cx('mt-0.5 shrink-0', m.id === 'full' ? 'text-bad' : 'text-muted')} />
              <span className="min-w-0 flex-1"><span className="block text-[12.5px]">{t(modeLabel(provider, m.id))}</span><span className="block text-[11px] text-subtle">{t(m.hint)}</span></span>
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
  const info = modelChoices(provider, { [provider]: status }).find((m) => m.id === (canonicalModel(provider, options.model) ?? defaultModel(provider, status)));
  const efforts = modelEfforts(provider, info);
  const tiers = info?.speedTiers ?? [];
  const ultra = provider === 'claude';
  if (!efforts.length && !tiers.length && !ultra) return null;
  const tier = tiers.find((x) => x.id === options.speed);
  const parts = [efforts.length ? (options.effort ? t(effortLabel(provider, options.effort)) : t('Auto')) : null, tier?.name, ultra && options.ultracode ? 'Ultracode' : null].filter(Boolean);
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
            {[undefined, ...efforts].map((e) => <Row key={e ?? 'auto'} active={options.effort === e} onClick={() => onChange({ effort: e })}>{e ? t(effortLabel(provider, e)) : t('Auto')}</Row>)}
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

export type PickPatch = { provider: ProviderId; options: ProviderOptions };
