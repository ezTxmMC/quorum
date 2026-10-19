import type { Block } from '@shared/types';
import { activeToolActivity } from '@/lib/toolActivity';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';

const LABELS = { command: 'Führt Befehl aus', search: 'Sucht', edit: 'Bearbeitet Datei', read: 'Liest Datei', task: 'Führt Aufgabe aus' };

export function ToolActivity({ blocks, onStop }: { blocks: Block[]; onStop?: () => void }) {
  const activity = activeToolActivity(blocks);
  if (!activity) return null;
  return <div className="flex min-w-0 items-center gap-2 text-[12px] text-subtle" role="status" aria-live="polite">
    <Icon name="lucide:loader-circle" size={13} className="spin shrink-0 text-accent" />
    <span className="min-w-0 flex-1 truncate" title={`${t(LABELS[activity.kind])}: ${activity.summary}`}>{t(LABELS[activity.kind])}: <span className="font-mono">{activity.summary}</span>{activity.count > 1 && <span> · +{activity.count - 1}</span>}</span>
    {onStop && <button className="icon-btn !size-6 shrink-0 text-bad hover:bg-bad/10" aria-label={t('Zugehörigen Lauf stoppen')} title={t('Zugehörigen Lauf stoppen')} onClick={onStop}><Icon name="lucide:square" size={11} /></button>}
  </div>;
}
