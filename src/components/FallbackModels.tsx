import { useState } from 'react';
import { PROVIDERS, canonicalModel } from '@shared/catalog';
import type { ChatSession, ProviderId } from '@shared/types';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { Dot, ModelList, useModelLabel } from './ModelPicker';
import { Popover, cx } from './ui';

function Row({ provider, model, index, onRemove }: { provider: ProviderId; model: string; index: number; onRemove: () => void }) {
  const label = useModelLabel(provider, model);
  return (
    <div className="flex items-center gap-2 rounded-lumen-sm px-2 py-1.5 hover:bg-hover">
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-active text-[10px] text-muted">{index + 1}</span>
      <Dot id={provider} size={7} />
      <span className="min-w-0 flex-1 truncate text-[12.5px]" title={`${PROVIDERS[provider].name} · ${model}`}>{PROVIDERS[provider].name} · {label}</span>
      <button className="icon-btn !size-5" title={t('Entfernen')} onClick={onRemove}><Icon name="lucide:x" size={12} /></button>
    </div>
  );
}

/** Ausweich-Modelle der Sitzung: ist das Nutzungslimit erreicht, wechselt der Chat automatisch zum ersten Eintrag und wiederholt die Anfrage. */
export function FallbackButton({ session }: { session: Pick<ChatSession, 'id' | 'provider' | 'fallbacks'> }) {
  const patch = useHub((s) => s.patchSession);
  const [adding, setAdding] = useState(false);
  const list = session.fallbacks ?? [];
  const set = (next: NonNullable<ChatSession['fallbacks']>) => patch(session.id, { fallbacks: next.length ? next : undefined });
  return (
    <Popover align="right" trigger={(open, toggle) => (
      <button onClick={toggle} title={t('Ausweich-Modelle bei erreichtem Limit')} className={cx('btn btn-ghost !gap-1 !px-2 text-subtle', (open || list.length > 0) && '!text-fg', open && '!bg-hover')}>
        <Icon name="lucide:life-buoy" size={14} />{list.length > 0 && <span className="text-[10.5px]">{list.length}</span>}
      </button>
    )}>
      {() => (
        <div className="w-80 max-w-[calc(100vw-3rem)] p-1">
          <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Ausweich-Modelle (diese Sitzung)')}</div>
          <p className="px-2 pb-2 text-[11.5px] text-subtle">{t('Wird das Nutzungslimit erreicht, wechselt der Chat zum ersten Modell der Liste und wiederholt die letzte Anfrage.')}</p>
          {list.map((f, i) => <Row key={`${f.provider}:${f.model}`} provider={f.provider} model={f.model} index={i} onRemove={() => set(list.filter((_, j) => j !== i))} />)}
          {!list.length && !adding && <div className="px-2 py-1.5 text-[12px] text-subtle">{t('Keine Ausweich-Modelle gewählt.')}</div>}
          {adding
            ? <div className="mt-1 rounded-lumen border border-edge"><ModelList kind="text" onPick={(p, id) => {
              const model = canonicalModel(p, id) ?? id;
              if (!list.some((f) => f.provider === p && f.model === model)) set([...list, { provider: p, model }]);
              setAdding(false);
            }} /></div>
            : <button className="btn btn-ghost mt-1 w-full !justify-start !px-2 text-muted" onClick={() => setAdding(true)}><Icon name="lucide:plus" size={14} /> {t('Modell hinzufügen')}</button>}
        </div>
      )}
    </Popover>
  );
}
