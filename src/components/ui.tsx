import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PROVIDERS } from '@shared/catalog';
import type { ProviderId } from '@shared/types';
import { Icon } from '@/lib/icons';

export function cx(...c: (string | false | undefined | null)[]) { return c.filter(Boolean).join(' '); }

/** Hält ein Element nach dem Schließen kurz gemountet, damit die Ausblend-Animation laufen kann. */
export function usePresence(open: boolean, ms = 150) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: mounted || open, state: open ? 'open' : 'closed' } as const;
}

/** Weiches Auf-/Zuklappen (Höhe animiert über grid-template-rows); Inhalt wird erst beim ersten Öffnen gerendert. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [seen, setSeen] = useState(open);
  useEffect(() => { if (open) setSeen(true); }, [open]);
  return (
    <div className="collapse-grid" data-open={open}>
      <div className="overflow-hidden">{seen ? children : null}</div>
    </div>
  );
}

export function ProviderMark({ id, size = 18 }: { id: ProviderId; size?: number }) {
  const p = PROVIDERS[id];
  return (
    <span className="inline-grid shrink-0 place-items-center rounded-md" style={{ width: size + 8, height: size + 8, background: `color-mix(in srgb, ${p.color} 18%, transparent)`, color: p.color }}>
      <Icon name={p.icon} size={size - 2} />
    </span>
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="text-[11.5px] font-medium text-muted">{children}</span>
      {hint && <span className="truncate text-[11px] text-subtle">{hint}</span>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, danger }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; danger?: boolean }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex w-full items-center gap-3 rounded-lumen-sm px-1 py-1.5 text-left hover:bg-hover">
      <span className={cx('relative h-[18px] w-8 shrink-0 rounded-full transition-colors', checked ? (danger ? 'bg-bad' : 'bg-accent') : 'bg-active')}>
        <span className={cx('absolute top-[2px] size-[14px] rounded-full bg-white transition-all', checked ? 'left-[16px]' : 'left-[2px]')} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]">{label}</span>
        {hint && <span className="block truncate text-[11px] text-subtle">{hint}</span>}
      </span>
    </button>
  );
}

export function Select<T extends string>({ value, onChange, options, placeholder, className }: { value: T | undefined; onChange: (v: T) => void; options: { value: T; label: string; hint?: string }[]; placeholder?: string; className?: string }) {
  return (
    <select className={cx('field appearance-none pr-7', className)} value={value ?? ''} onChange={(e) => onChange(e.target.value as T)} style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' fill=\'none\' stroke=\'%23888\' stroke-width=\'1.5\'%3E%3Cpath d=\'m1 1 4 4 4-4\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 9px center' }}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Popover({ trigger, children, align = 'left', down }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; down?: boolean }) {
  const [open, setOpen] = useState(false);
  const { mounted, state } = usePresence(open);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {mounted && (
        <div data-state={state} className={cx('pop absolute z-40 min-w-56 rounded-lumen border border-edge-strong bg-overlay p-1 shadow-2xl', down ? 'top-full mt-2 origin-top' : 'bottom-full mb-2 origin-bottom', align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, hint, active, onClick }: { icon?: ReactNode; children: ReactNode; hint?: string; active?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cx('flex w-full items-center gap-2.5 rounded-lumen-sm px-2.5 py-1.5 text-left hover:bg-hover', active && 'bg-active')}>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px]">{children}</span>
        {hint && <span className="block truncate text-[11px] text-subtle">{hint}</span>}
      </span>
      {active && <Icon name="lucide:check" size={14} className="text-accent" />}
    </button>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-lumen-lg border border-edge bg-surface text-muted"><Icon name={icon} size={22} /></div>
        <h2 className="mb-1.5 text-[17px] font-semibold">{title}</h2>
        <div className="text-muted">{children}</div>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, wide, xl, bare }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; xl?: boolean; bare?: boolean }) {
  const [open, setOpen] = useState(true);
  const close = () => { setOpen(false); setTimeout(onClose, 150); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setTimeout(onClose, 150); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const state = open ? 'open' : 'closed';
  return (
    <div data-state={state} className="fade-bg fixed inset-0 z-50 grid place-items-center bg-black/50 p-6 " onMouseDown={close}>
      <div data-state={state} className={cx('pop flex max-h-full w-full flex-col overflow-hidden rounded-lumen-lg border border-edge-strong bg-overlay shadow-2xl', xl ? 'h-[84vh] max-w-5xl' : wide ? 'max-w-3xl' : 'max-w-xl')} onMouseDown={(e) => e.stopPropagation()}>
        {!bare && (
          <div className="flex items-center justify-between border-b border-edge px-4 py-3">
            <h3 className="text-[14px] font-semibold">{title}</h3>
            <button className="icon-btn" onClick={close}><Icon name="lucide:x" /></button>
          </div>
        )}
        <div className={cx('min-h-0 flex-1', bare ? 'flex' : 'overflow-y-auto p-4')}>{children}</div>
      </div>
    </div>
  );
}

/** Kopier-Button mit kurzer Bestätigung (Icon wechselt weich zu einem Haken). */
export function CopyButton({ text, className, title }: { text: string | (() => string); className?: string; title?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" title={title ?? 'Copy'} className={cx('icon-btn !size-6 transition-colors', ok && '!text-ok', className)}
      onClick={() => { void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => { setOk(true); setTimeout(() => setOk(false), 1400); }); }}>
      <span className="relative grid size-4 place-items-center">
        <Icon name="lucide:copy" size={14} className={cx('absolute transition-all duration-200', ok ? 'scale-50 opacity-0' : 'scale-100 opacity-100')} />
        <Icon name="lucide:check" size={14} className={cx('absolute transition-all duration-200', ok ? 'scale-100 opacity-100' : 'scale-50 opacity-0')} />
      </span>
    </button>
  );
}

export function ShortPath({ path }: { path: string }) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return <span title={path}>{parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path}</span>;
}
