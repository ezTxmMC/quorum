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
import { MenuItem, Popover, cx } from '../ui';

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

function TerminalView({ cwd, shell, active, onExit }: { cwd: string; shell?: string; active: boolean; onExit: (code: number | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const style = useHub((s) => s.data.settings.terminal);
  const theme = useHub((s) => s.data.settings.theme + s.data.settings.accent);
  const termRef = useRef<{ term: Terminal; fit: () => void } | null>(null);
  const cwdRef = useRef(cwd);
  const shellRef = useRef(shell);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
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
    void hub.termCreate(id, cwdRef.current, term.cols || 80, term.rows || 24, undefined, shellRef.current).then((r) => { mode = r.mode === 'pipe' ? 'pipe' : 'pty'; ready = true; });

    const offData = hub.onTermData((p) => { if (p.id === id) term.write(p.data); });
    const offExit = hub.onTermExit((p) => { if (p.id === id) { term.write(`\r\n\x1b[2m[${t('Prozess beendet')}]\x1b[0m\r\n`); exitRef.current(p.code); } });
    // Zwischenablage: Strg+Umschalt+C/V sowie Strg+C mit Auswahl kopiert statt SIGINT zu senden.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey)) return true;
      const k = e.key.toLowerCase();
      if (k === 'c' && (e.shiftKey || term.hasSelection())) { const sel = term.getSelection(); if (sel) void navigator.clipboard.writeText(sel); return false; }
      if (k === 'v' && e.shiftKey) { e.preventDefault(); void navigator.clipboard.readText().then((x) => x && term.paste(x)); return false; }
      return true;
    });
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

  // Innenabstand liegt am äußeren Rahmen: FitAddon misst das Elternelement von xterm und zieht dessen Padding nicht ab.
  return <div className={cx('absolute inset-0 px-2 pt-1', !active && 'invisible')} style={{ background: termBackground(style) }}><div ref={host} className="size-full" /></div>;
}

interface Tab { key: string; title: string; exited: boolean; shell?: string }

/** Mehrere Terminals als Tabs (je mit eigener Shell); jedes weitere kann auch in einem eigenen Fenster geöffnet werden. */
export function TerminalPanel({ cwd, slot, onCloseAll }: { cwd: string; slot?: HTMLElement | null; onCloseAll?: () => void }) {
  const counter = useRef(1);
  const [tabs, setTabs] = useState<Tab[]>([{ key: uid(), title: 'Terminal 1', exited: false }]);
  const [cur, setCur] = useState(tabs[0].key);
  const [shells, setShells] = useState<{ id: string; name: string; path: string }[]>([]);
  const style = useHub((s) => s.data.settings.terminal);
  const defaultShell = useHub((s) => s.data.settings.terminal.shell);
  useEffect(() => { void hub.termShells().then(setShells).catch(() => {}); }, []);

  const fresh = (shell?: string): Tab => { counter.current += 1; const n = shells.find((x) => x.path === shell)?.name; return { key: uid(), title: n ? `${n} ${counter.current}` : `Terminal ${counter.current}`, exited: false, shell }; };
  const add = (shell?: string) => { const n = fresh(shell ?? defaultShell); setTabs((x) => [...x, n]); setCur(n.key); };
  const close = (k: string) => {
    const rest = tabs.filter((y) => y.key !== k);
    if (!rest.length) {
      // Letztes Terminal geschlossen: Panel zuklappen (im eigenen Fenster: Fenster schließen) und beim nächsten Öffnen frisch starten.
      const n = fresh(tabs[0]?.shell);
      setTabs([n]); setCur(n.key);
      if (onCloseAll) onCloseAll(); else if (slot === undefined) window.close();
      return;
    }
    if (k === cur) setCur(rest[Math.max(0, tabs.findIndex((y) => y.key === k) - 1)].key);
    setTabs(rest);
  };
  const restart = (k: string) => { const n = uid(); setTabs((x) => x.map((y) => (y.key === k ? { ...y, key: n, exited: false } : y))); if (k === cur) setCur(n); };
  // Beendet der Nutzer die Shell (exit / Strg+D), schließt sich der Tab; bei Fehlercode bleibt er mit Hinweis stehen.
  const onExit = (k: string, code: number | null) => {
    if (code === 0 || code === null) close(k);
    else setTabs((x) => x.map((y) => (y.key === k ? { ...y, exited: true } : y)));
  };
  const curTab = tabs.find((x) => x.key === cur);

  const tabStrip = tabs.map((x) => (
    <div key={x.key} className={cx('group flex shrink-0 items-center gap-1 rounded-lumen-sm py-0.5 pl-2 pr-1 text-[11.5px] transition-colors', x.key === cur ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg')}>
      <button className="flex items-center gap-1.5" onClick={() => setCur(x.key)}>
        <Icon name="lucide:square-terminal" size={12} className={x.exited ? 'text-subtle' : ''} /> {x.title}
      </button>
      <button className={cx('icon-btn !size-4 opacity-0 transition-opacity group-hover:opacity-100', x.key === cur && 'opacity-60')} title={t('Schließen')} onClick={() => close(x.key)}><Icon name="lucide:x" size={11} /></button>
    </div>
  ));
  const controls = (
    <>
      <button className="icon-btn !size-6 shrink-0" title={t('Neues Terminal')} onClick={() => add()}><Icon name="lucide:plus" size={13} /></button>
      {shells.length > 1 && (
        <Popover down trigger={(_o, toggle) => <button className="icon-btn !size-6 shrink-0" title={t('Shell wählen')} onClick={toggle}><Icon name="lucide:chevron-down" size={12} /></button>}>
          {(closeMenu) => (
            <div className="min-w-48">
              <div className="px-2.5 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Neues Terminal mit …')}</div>
              {shells.map((sh) => <MenuItem key={sh.id} icon={<Icon name="lucide:square-terminal" size={14} className="text-muted" />} hint={sh.path} active={(defaultShell ?? shells[0].path) === sh.path} onClick={() => { add(sh.path); closeMenu(); }}>{sh.name}</MenuItem>)}
              <div className="my-1 border-t border-edge" />
              <MenuItem icon={<Icon name="lucide:pin" size={14} className="text-muted" />} onClick={() => { const sh = curTab?.shell ?? defaultShell ?? shells[0].path; useHub.getState().setSettings({ terminal: { ...style, shell: sh } }); closeMenu(); }}>{t('Aktuelle Shell als Standard')}</MenuItem>
            </div>
          )}
        </Popover>
      )}
      <div className="flex-1" />
      {curTab && <button className="icon-btn !size-6 shrink-0" title={t('Terminal neu starten (aktueller Projektordner)')} onClick={() => restart(curTab.key)}><Icon name={curTab.exited ? 'lucide:rotate-ccw' : 'lucide:refresh-cw'} size={12} /></button>}
      <button className="icon-btn !size-6 shrink-0" title={t('Neues Terminal-Fenster')} onClick={() => void hub.newWindow(`/popout/terminal?cwd=${encodeURIComponent(cwd)}`)}><Icon name="lucide:app-window" size={13} /></button>
    </>
  );
  // Im Dock: Tabs inline in der Panel-Kopfzeile direkt neben „Terminal“. Im eigenen Fenster: eigene Leiste.
  const docked = slot !== undefined;
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: termBackground(style) }}>
      {docked ? (slot ? createPortal(<div className="flex min-w-0 flex-1 items-center gap-0.5"><span className="mx-1 h-4 w-px shrink-0 bg-edge" /><div className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">{tabStrip}</div>{controls}</div>, slot) : null)
        : <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-edge bg-surface px-1"><div className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">{tabStrip}</div>{controls}</div>}
      <div className="relative min-h-0 flex-1">
        {tabs.map((x) => <TerminalView key={x.key} cwd={cwd} shell={x.shell} active={x.key === cur} onExit={(code) => onExit(x.key, code)} />)}
      </div>
    </div>
  );
}
