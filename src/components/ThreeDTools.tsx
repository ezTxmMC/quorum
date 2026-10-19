import { useEffect, useState } from 'react';
import type { ToolId, ToolStatus } from '@shared/threed';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { cx } from './ui';

type Progress = { step: string; percent?: number; error?: string };

const INFO: Record<ToolId, { name: string; icon: string; text: string }> = {
  blender: { name: 'Blender', icon: 'lucide:box', text: 'Rendert Vorschauen, vereinfacht und exportiert Modelle. Läuft ohne Netzwerk.' },
  blockbench: { name: 'Blockbench', icon: 'lucide:cuboid', text: 'Live-Ansicht und Editor für Low-Poly-Modelle, optional mit Community-MCP-Plugin.' },
};

const mb = (n: number) => (n > 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** Einzeln installierbare, sandboxed Werkzeuge der 3D-Umgebung. */
export function ThreeDTools({ onChange }: { onChange?: (s: ToolStatus[]) => void }) {
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [progress, setProgress] = useState<Partial<Record<ToolId, Progress>>>({});
  const [mcp, setMcpWanted] = useState(true);
  const [open, setOpen] = useState(false);

  const apply = (s: ToolStatus[]) => { setTools(s); onChange?.(s); };
  const reload = () => void hub.threedTools().then(apply);
  useEffect(() => {
    reload();
    return hub.onThreedToolProgress((p) => {
      setProgress((c) => ({ ...c, [p.id]: p.done && !p.error ? undefined : { step: p.step, percent: p.percent, error: p.error } }));
      if (p.done) reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const missing = tools.some((x) => !x.installed);
  useEffect(() => { if (tools.length && missing) setOpen(true); }, [tools.length, missing]);
  const sandbox = tools[0]?.sandbox;

  return (
    <section className="rounded-lumen-lg border border-edge bg-surface">
      <button className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setOpen((o) => !o)}>
        <Icon name="lucide:package" size={15} className="text-muted" />
        <span className="flex-1 text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Werkzeuge')}</span>
        {tools.map((x) => <span key={x.id} className={cx('rounded-full px-2 py-0.5 text-[11px]', x.installed ? 'bg-ok/15 text-ok' : 'bg-hover text-subtle')}>{INFO[x.id].name}</span>)}
        <Icon name={open ? 'lucide:chevron-up' : 'lucide:chevron-down'} size={14} className="text-subtle" />
      </button>
      {open && (
        <div className="space-y-3 border-t border-edge p-4">
          <p className="text-[12px] text-subtle">
            {sandbox === 'bubblewrap'
              ? t('Installiert in den App-Ordner und läuft in einer bubblewrap-Sandbox: nur Werkzeug- und Projektordner sind sichtbar.')
              : t('bubblewrap ist nicht installiert: die Werkzeuge liegen im App-Ordner und laufen mit eigenem Profil, aber ohne Dateisystem-Sandbox.')}
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {tools.map((x) => {
              const info = INFO[x.id];
              const p = progress[x.id];
              const busy = !!p && !p.error;
              return (
                <div key={x.id} className="space-y-2 rounded-lumen border border-edge p-3">
                  <div className="flex items-center gap-2">
                    <Icon name={info.icon} size={16} className="text-muted" />
                    <span className="font-medium">{info.name}</span>
                    {x.version && <span className="font-mono text-[11px] text-subtle">{x.version}</span>}
                    <span className="flex-1" />
                    {x.installed && <span className="text-[11px] text-subtle">{mb(x.size)}</span>}
                  </div>
                  <p className="text-[12px] text-subtle">{t(info.text)}</p>
                  {x.id === 'blockbench' && (
                    <label className="flex items-center gap-2 text-[12px]">
                      <input type="checkbox" checked={x.installed ? !!x.mcp : mcp} disabled={busy} onChange={(e) => {
                        if (x.installed) void hub.threedToolMcp(e.target.checked).then(apply).catch(() => reload());
                        else setMcpWanted(e.target.checked);
                      }} />
                      {t('Community-MCP-Plugin')} <span className="text-subtle">(jasonjgardner/blockbench-mcp-plugin)</span>
                    </label>
                  )}
                  {busy && (
                    <div className="space-y-1">
                      <div className="h-1.5 overflow-hidden rounded-full bg-active"><div className="h-full bg-accent transition-[width]" style={{ width: `${p?.percent ?? 8}%` }} /></div>
                      <div className="text-[11px] text-subtle">{p?.step}{p?.percent !== undefined ? ` · ${p.percent} %` : ''}</div>
                    </div>
                  )}
                  {p?.error && <div className="text-[12px] text-bad">{p.error}</div>}
                  <div className="flex gap-2">
                    {busy
                      ? <button className="btn" onClick={() => void hub.threedToolCancel(x.id)}><Icon name="lucide:square" size={13} /> {t('Abbrechen')}</button>
                      : x.installed
                        ? <button className="btn" onClick={() => void hub.threedToolRemove(x.id).then(apply)}><Icon name="lucide:trash-2" size={13} /> {t('Entfernen')}</button>
                        : <button className="btn btn-primary" onClick={() => { setProgress((c) => ({ ...c, [x.id]: { step: '…' } })); void hub.threedToolInstall(x.id, { mcp }); }}><Icon name="lucide:download" size={13} /> {t('Sandboxed installieren')}</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
