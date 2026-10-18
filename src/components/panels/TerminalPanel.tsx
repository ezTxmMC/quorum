import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_THEMES } from '@shared/catalog';
import type { TerminalStyle } from '@shared/types';
import { hub, uid } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { cx } from '../ui';

function appTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return { background: v('--c-bg-elevated'), foreground: v('--c-text'), cursor: v('--c-accent'), selectionBackground: v('--c-selection'), black: v('--c-bg'), brightBlack: v('--c-text-subtle') };
}

/** xterm-Optionen aus dem Terminal-Stil der Einstellungen. */
export function termOptions(s: TerminalStyle): ITerminalOptions {
  return {
    fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, cursorStyle: s.cursorStyle, cursorBlink: s.cursorBlink, scrollback: s.scrollback,
    theme: TERMINAL_THEMES[s.theme]?.colors ?? appTheme(),
  };
}
export const termBackground = (s: TerminalStyle) => TERMINAL_THEMES[s.theme]?.colors.background ?? 'var(--c-bg-elevated)';

function TerminalView({ cwd, active, onExit }: { cwd: string; active: boolean; onExit: (exited: boolean) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const style = useHub((s) => s.data.settings.terminal);
  const theme = useHub((s) => s.data.settings.theme + s.data.settings.accent);
  const termRef = useRef<{ term: Terminal; fit: () => void } | null>(null);
  const cwdRef = useRef(cwd);
  const styleRef = useRef(style);
  styleRef.current = style;

  useEffect(() => {
    if (!host.current) return;
    const id = uid();
    const term = new Terminal({ ...termOptions(styleRef.current), allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    let mode: 'pty' | 'pipe' = 'pty';
    let line = '';
    let ready = false;

    const safeFit = () => { try { fit.fit(); } catch { /* Panel versteckt */ } };
    termRef.current = { term, fit: () => { safeFit(); if (ready) void hub.termResize(id, term.cols, term.rows); } };
    safeFit();
    void hub.termCreate(id, cwdRef.current, term.cols || 80, term.rows || 24).then((r) => { mode = r.mode === 'pipe' ? 'pipe' : 'pty'; ready = true; });

    const offData = hub.onTermData((p) => { if (p.id === id) term.write(p.data); });
    const offExit = hub.onTermExit((p) => { if (p.id === id) { onExit(true); term.write(`\r\n\x1b[2m[${t('Prozess beendet')}]\x1b[0m\r\n`); } });
    term.onData((d) => {
      if (!ready) return;
      if (mode === 'pty') { void hub.termWrite(id, d); return; }
      // Pipe-Modus (Windows): lokales Echo und Zeilenpuffer
      for (const ch of d) {
        if (ch === '\r') { term.write('\r\n'); void hub.termWrite(id, line + '\r\n'); line = ''; }
        else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); term.write('\b \b'); } }
        else if (ch >= ' ') { line += ch; term.write(ch); }
      }
    });
    const ro = new ResizeObserver(() => { if (host.current?.offsetWidth) termRef.current?.fit(); });
    ro.observe(host.current);
    return () => { ro.disconnect(); offData(); offExit(); void hub.termKill(id); term.dispose(); termRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Stiländerungen aus den Einstellungen live übernehmen.
  useEffect(() => {
    const r = termRef.current;
    if (!r) return;
    r.term.options = termOptions(style);
    requestAnimationFrame(() => r.fit());
  }, [style, theme]);

  useEffect(() => { if (active) requestAnimationFrame(() => { termRef.current?.fit(); termRef.current?.term.focus(); }); }, [active]);

  return <div ref={host} className={cx('absolute inset-0 px-2 pt-1', !active && 'invisible')} style={{ background: termBackground(style) }} />;
}

interface Tab { key: string; title: string; exited: boolean }

/** Mehrere Terminals als Tabs; jedes weitere kann auch in einem eigenen Fenster geöffnet werden. */
export function TerminalPanel({ cwd, slot }: { cwd: string; slot?: HTMLElement | null }) {
  const counter = useRef(1);
  const [tabs, setTabs] = useState<Tab[]>([{ key: uid(), title: 'Terminal 1', exited: false }]);
  const [cur, setCur] = useState(tabs[0].key);
  const style = useHub((s) => s.data.settings.terminal);

  const add = () => { const k = uid(); counter.current += 1; setTabs((x) => [...x, { key: k, title: `Terminal ${counter.current}`, exited: false }]); setCur(k); };
  const close = (k: string) => setTabs((x) => {
    const rest = x.filter((y) => y.key !== k);
    if (!rest.length) { counter.current += 1; const n = { key: uid(), title: `Terminal ${counter.current}`, exited: false }; setCur(n.key); return [n]; }
    if (k === cur) setCur(rest[Math.max(0, x.findIndex((y) => y.key === k) - 1)].key);
    return rest;
  });
  const restart = (k: string) => { const n = uid(); setTabs((x) => x.map((y) => (y.key === k ? { ...y, key: n, exited: false } : y))); if (k === cur) setCur(n); };
  const setExited = (k: string) => setTabs((x) => x.map((y) => (y.key === k ? { ...y, exited: true } : y)));
  const curTab = tabs.find((x) => x.key === cur);

  const strip = (
    <>
        {tabs.map((x) => (
          <div key={x.key} className={cx('group flex shrink-0 items-center gap-1 rounded-lumen-sm py-0.5 pl-2 pr-1 text-[11.5px] transition-colors', x.key === cur ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg')}>
            <button className="flex items-center gap-1.5" onClick={() => setCur(x.key)}>
              <Icon name="lucide:square-terminal" size={12} className={x.exited ? 'text-subtle' : ''} /> {x.title}
            </button>
            <button className={cx('icon-btn !size-4 opacity-0 transition-opacity group-hover:opacity-100', x.key === cur && 'opacity-60')} title={t('Schließen')} onClick={() => close(x.key)}><Icon name="lucide:x" size={11} /></button>
          </div>
        ))}
        <button className="icon-btn !size-6 shrink-0" title={t('Neues Terminal')} onClick={add}><Icon name="lucide:plus" size={13} /></button>
        <div className="flex-1" />
        {curTab && <button className="icon-btn !size-6 shrink-0" title={t('Terminal neu starten (aktueller Projektordner)')} onClick={() => restart(curTab.key)}><Icon name={curTab.exited ? 'lucide:rotate-ccw' : 'lucide:refresh-cw'} size={12} /></button>}
        <button className="icon-btn !size-6 shrink-0" title={t('Neues Terminal-Fenster')} onClick={() => void hub.newWindow(`/popout/terminal?cwd=${encodeURIComponent(cwd)}`)}><Icon name="lucide:app-window" size={13} /></button>
    </>
  );
  // Im Dock: Tabs inline in der Panel-Kopfzeile direkt neben „Terminal“. Im eigenen Fenster: eigene Leiste.
  const docked = slot !== undefined;
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: termBackground(style) }}>
      {docked ? (slot ? createPortal(<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"><span className="mx-1 h-4 w-px shrink-0 bg-edge" />{strip}</div>, slot) : null)
        : <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge bg-surface px-1">{strip}</div>}
      <div className="relative min-h-0 flex-1">
        {tabs.map((x) => <TerminalView key={x.key} cwd={cwd} active={x.key === cur} onExit={() => setExited(x.key)} />)}
      </div>
    </div>
  );
}
