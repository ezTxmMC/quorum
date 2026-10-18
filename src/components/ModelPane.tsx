import { t } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { hub } from '@/lib/api';
import { imageUrl } from '@/components/MessageView';
import { Icon } from '@/lib/icons';

/** Nur das Modell: Live-Ausschnitt aus Blockbench (headless) oder das letzte Blender-Rendering. Keine Werkzeuge. */
export function ModelPane({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [live, setLive] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [still, setStill] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setFrame(null); setErr(null);
    void hub.threedGet(projectId).then((d) => {
      const iso = d.renders.filter((p) => p.endsWith('-iso.png')).at(-1);
      setStill(iso ?? null);
    }).catch(() => setStill(null));
    void hub.threedViewerStatus(projectId).then(setLive);
    return hub.onThreedFrame((f) => {
      if (f.projectId !== projectId) return;
      if (f.error) setErr(f.error);
      if (f.jpeg) setFrame(`data:image/jpeg;base64,${f.jpeg}`);
    });
  }, [projectId]);

  const toggle = async () => {
    setErr(null);
    try {
      if (live) { await hub.threedViewerClose(projectId); setLive(false); setFrame(null); }
      else { await hub.threedViewerOpen(projectId); setLive(true); }
    } catch (e) { setErr((e as Error).message); }
  };

  const shown = frame ?? (still ? imageUrl(still) : null);
  return (
    <aside className="dock-zone dock-right flex w-[400px] shrink-0 flex-col border-l border-edge bg-surface">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="flex-1 font-medium">{t('Modell')}</span>
        <button className="btn" onClick={() => void toggle()}>{live ? t('Live aus') : t('Live an')}</button>
        <button className="icon-btn" onClick={() => void hub.threedViewerClose(projectId).then(onClose)}><Icon name="lucide:x" /></button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        {shown
          ? <img src={shown} alt="" className="max-h-full max-w-full rounded-lumen border border-edge" />
          : <div className="text-center text-[12px] text-subtle">{t('Noch keine Vorschau.')}</div>}
      </div>
      {err && <div className="px-3 pb-2 text-[12px] text-bad">{err}</div>}
    </aside>
  );
}
