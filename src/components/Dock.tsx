import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DockPos, PanelId } from '@shared/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { ChangesPanel } from './ChangesPanel';
import { AgentsPanel } from './panels/AgentsPanel';
import { FilesPanel } from './panels/FilesPanel';
import { TerminalPanel } from './panels/TerminalPanel';
import { MenuItem, Popover, cx, usePresence } from './ui';

export const PANELS: { id: PanelId; icon: string; label: string }[] = [
  { id: 'terminal', icon: 'lucide:terminal', label: 'Terminal' },
  { id: 'files', icon: 'lucide:folder-tree', label: 'Ordner' },
  { id: 'agents', icon: 'lucide:bot', label: 'Agenten & Aufgaben' },
  { id: 'changes', icon: 'lucide:git-compare', label: 'Änderungen' },
];
const POS_ICONS: Record<DockPos, string> = { left: 'lucide:panel-left', right: 'lucide:panel-right', top: 'lucide:panel-top', bottom: 'lucide:panel-bottom' };
const POS_LABELS: Record<DockPos, string> = { left: 'Links', right: 'Rechts', top: 'Oben', bottom: 'Unten' };
/** Abstand der schwebenden Vollbild-Insel zum Fensterrand (4 × 4 px) und Höhe der Titelleiste. */
const ISLAND_MARGIN = 16;
const TOPBAR_H = 40;

/** slot: Platz in der Kopfzeile des Docks – dort zeigt das Terminal seine Tabs direkt neben dem Panel-Namen. */
export function PanelBody({ id, cwd, slot }: { id: PanelId; cwd: string; slot?: HTMLElement | null }) {
  switch (id) {
    case 'terminal': return <TerminalPanel cwd={cwd} slot={slot} onCloseAll={slot !== undefined ? () => useHub.getState().togglePanel('terminal') : undefined} />;
    case 'files': return <FilesPanel cwd={cwd} />;
    case 'agents': return <AgentsPanel />;
    case 'changes': return cwd ? <ChangesPanel cwd={cwd} /> : <div className="p-4 text-muted">{t('Kein Ordner gewählt.')}</div>;
  }
}

function Zone({ pos, opened }: { pos: DockPos; opened: Set<PanelId> }) {
  const dock = useHub((s) => s.data.settings.dock);
  const activeCwd = useHub((s) => s.activeCwd);
  const fallback = useHub((s) => s.data.recentProjects[0] ?? '');
  const { togglePanel, movePanel, resizeDock, setMaximizedPanel } = useHub.getState();
  const maximizedPanel = useHub((s) => s.maximizedPanel);
  const cwd = activeCwd || fallback;
  const horizontal = pos === 'left' || pos === 'right';

  const mine = PANELS.filter((p) => dock.panels[p.id].pos === pos && (dock.panels[p.id].visible || opened.has(p.id)));
  const visible = mine.filter((p) => dock.panels[p.id].visible);
  const [active, setActive] = useState<PanelId | null>(null);
  const cur = visible.find((p) => p.id === active) ?? visible[0];
  const { mounted, state } = usePresence(visible.length > 0, 170);
  const [drag, setDrag] = useState<number | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const size = drag ?? dock.sizes[pos];
  const last = useRef(0);

  const isMax = !!cur && maximizedPanel === cur.id;
  useEffect(() => {
    if (!isMax) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setMaximizedPanel(null); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [isMax, setMaximizedPanel]);
  useEffect(() => { if (visible.length && !visible.some((p) => p.id === active)) setActive(visible[visible.length - 1].id); }, [visible.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!mine.length) return null;

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = horizontal ? e.clientX : e.clientY;
    const base = dock.sizes[pos];
    const sign = pos === 'left' || pos === 'top' ? 1 : -1;
    const max = (horizontal ? window.innerWidth : window.innerHeight) * 0.75;
    const move = (ev: PointerEvent) => {
      const now = performance.now();
      if (now - last.current < 12) return; // ~60 fps
      last.current = now;
      setDrag(Math.max(160, Math.min(max, base + sign * ((horizontal ? ev.clientX : ev.clientY) - start))));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const v = Math.max(160, Math.min(max, base + sign * ((horizontal ? ev.clientX : ev.clientY) - start)));
      setDrag(null); resizeDock(pos, v);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const handle = (
    <div onPointerDown={startDrag} className={cx('group absolute z-10', horizontal ? 'top-0 h-full w-1.5 cursor-col-resize' : 'left-0 h-1.5 w-full cursor-row-resize', pos === 'left' && 'right-[-3px]', pos === 'right' && 'left-[-3px]', pos === 'top' && 'bottom-[-3px]', pos === 'bottom' && 'top-[-3px]')}>
      <div className={cx('mx-auto bg-accent opacity-0 transition-opacity group-hover:opacity-60', horizontal ? 'h-full w-px' : 'mt-[3px] h-px w-full', drag !== null && '!opacity-100')} />
    </div>
  );

  const islandStyle = isMax ? { top: TOPBAR_H + ISLAND_MARGIN, left: ISLAND_MARGIN, right: ISLAND_MARGIN, bottom: ISLAND_MARGIN } : horizontal ? { width: size } : { height: size };
  return (
    <>
      {/* Platzhalter hält die Größe der Zone, solange das Panel als Insel schwebt – der Hauptbereich springt nicht. */}
      {isMax && <div className="shrink-0" style={horizontal ? { width: size } : { height: size }} />}
      {isMax && <div className="bg-in fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" style={{ top: TOPBAR_H }} onClick={() => setMaximizedPanel(null)} />}
      <section data-state={state} className={cx('dock-zone flex flex-col bg-surface', isMax ? 'fixed z-[45] overflow-hidden rounded-lumen-lg border border-edge-strong shadow-2xl' : 'relative shrink-0', !mounted && 'hidden', !isMax && pos === 'left' && 'dock-left border-r border-edge', !isMax && pos === 'right' && 'dock-right border-l border-edge', !isMax && pos === 'top' && 'dock-top border-b border-edge', !isMax && pos === 'bottom' && 'dock-bottom border-t border-edge')}
        style={islandStyle}>
        {!isMax && handle}
        {cur && (
          <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-edge px-1.5">
            {visible.map((p) => (
              <button key={p.id} onClick={() => setActive(p.id)} title={t(p.label)} aria-label={t(p.label)} className={cx('icon-btn !size-7', p.id === cur.id ? 'bg-active text-fg' : 'text-muted hover:text-fg')}>
                <Icon name={p.icon} size={14} />
              </button>
            ))}
            <div ref={setSlot} className="flex min-w-0 flex-1 items-center gap-0.5" />
            {!isMax && (
              <Popover down align="right" trigger={(_o, toggle) => <button className="icon-btn !size-6" title={t('Andocken:') + ' ' + t(POS_LABELS[pos])} onClick={toggle}><Icon name={POS_ICONS[pos]} size={14} /></button>}>
                {(closeMenu) => (
                  <div className="min-w-36">
                    {(['left', 'top', 'bottom', 'right'] as DockPos[]).map((p) => <MenuItem key={p} active={p === pos} icon={<Icon name={POS_ICONS[p]} size={14} className="text-muted" />} onClick={() => { movePanel(cur.id, p); closeMenu(); }}>{t(POS_LABELS[p])}</MenuItem>)}
                  </div>
                )}
              </Popover>
            )}
            <button className={cx('icon-btn !size-6', isMax && 'text-accent')} title={isMax ? t('Vollbild beenden (Esc)') : t('Vollbild')} onClick={() => setMaximizedPanel(isMax ? null : cur.id)}><Icon name={isMax ? 'lucide:minimize-2' : 'lucide:maximize-2'} size={13} /></button>
            <button className="icon-btn !size-6" title={t('In eigenem Fenster öffnen')} onClick={() => { void hub.newWindow(`/popout/${cur.id}?cwd=${encodeURIComponent(cwd)}`); togglePanel(cur.id); }}><Icon name="lucide:external-link" size={13} /></button>
            <button className="icon-btn !size-6" title={t('Schließen')} onClick={() => togglePanel(cur.id)}><Icon name="lucide:x" size={14} /></button>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {mine.map((p) => (
            <div key={p.id} className={cx('absolute inset-0', p.id !== cur?.id && 'hidden')}><PanelBody id={p.id} cwd={cwd} slot={p.id === cur?.id ? slot : undefined} /></div>
          ))}
        </div>
      </section>
    </>
  );
}

/** Ordnet die Panels links/rechts/oben/unten um den Hauptbereich an. */
export function Dock({ children }: { children: ReactNode }) {
  const panels = useHub((s) => s.data.settings.dock.panels);
  const [opened, setOpened] = useState<Set<PanelId>>(new Set());
  useEffect(() => {
    const vis = PANELS.filter((p) => panels[p.id].visible && !opened.has(p.id)).map((p) => p.id);
    if (vis.length) setOpened((o) => new Set([...o, ...vis]));
  }, [panels, opened]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Zone pos="top" opened={opened} />
      <div className="flex min-h-0 min-w-0 flex-1">
        <Zone pos="left" opened={opened} />
        <div className="relative min-h-0 min-w-0 flex-1">{children}</div>
        <Zone pos="right" opened={opened} />
      </div>
      <Zone pos="bottom" opened={opened} />
    </div>
  );
}
