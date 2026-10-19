import type { ChatMode } from '@shared/types';
import { CHAT_MODES } from '@shared/chat-modes';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { Popover, cx } from './ui';

export function ChatModeButton({ value, onChange, disabled }: { value: ChatMode; onChange: (mode: ChatMode) => void; disabled?: boolean }) {
  const current = CHAT_MODES.find((mode) => mode.id === value)!;
  return <Popover trigger={(open, toggle) => <button disabled={disabled} className={cx('btn btn-ghost !gap-1.5 !px-2 text-muted', open && '!bg-hover')} aria-label={`${t('Chat-Modus')}: ${t(current.label)}`} aria-expanded={open} onClick={toggle}>
    <Icon name={current.icon} size={14} /><span className="text-[12.5px]">{t(current.label)}</span><Icon name="lucide:chevron-down" size={12} />
  </button>}>
    {(close) => <div className="w-72">{CHAT_MODES.map((mode) => <button disabled={disabled} key={mode.id} className={cx('flex w-full items-center gap-2.5 rounded-lumen-sm px-2.5 py-2 text-left hover:bg-hover', value === mode.id && 'bg-active')} onClick={() => { onChange(mode.id); close(); }}>
      <Icon name={mode.icon} size={16} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1"><span className="block text-[12.5px]">{t(mode.label)}</span><span className="block text-[11px] text-subtle">{t(mode.description)}</span></span>
      {value === mode.id && <Icon name="lucide:check" size={14} className="text-accent" />}
    </button>)}</div>}
  </Popover>;
}
