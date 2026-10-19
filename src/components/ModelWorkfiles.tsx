import { useEffect, useState } from 'react';
import type { WorkfileItem } from '../../electron/3d/service';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { cx } from './ui';

const fmtBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const FILE_ICONS: Record<WorkfileItem['type'], string> = {
  bbmodel: 'lucide:cuboid',
  blend: 'lucide:box',
  texture: 'lucide:image',
  animation: 'lucide:film',
  export: 'lucide:package',
};

const TYPE_NAMES: Record<WorkfileItem['type'], string> = {
  bbmodel: 'Blockbench-Modell',
  blend: 'Blender-Szene',
  texture: 'Textur-Palette (PNG)',
  animation: 'Animationen (JSON)',
  export: 'Exportierte 3D-Datei',
};

export function ModelWorkfiles({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<WorkfileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const threedSettings = useHub((s) => s.data.settings.threed) ?? { preferredTool: 'blockbench', defaultExportFormat: 'glb', autoExport: true };
  const setSettings = useHub((s) => s.setSettings);

  const preferredTool = threedSettings.preferredTool ?? 'blockbench';
  const exportFormat = (threedSettings.defaultExportFormat ?? 'glb') as 'glb' | 'gltf' | 'obj' | 'fbx';

  const reload = async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await hub.threedWorkfiles(projectId);
      setFiles(list);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [projectId]);

  const handleExport = async (fmt: 'glb' | 'gltf' | 'obj' | 'fbx') => {
    setExporting(true);
    setErr(null);
    setSuccess(null);
    try {
      const outPath = await hub.threedExport(projectId, fmt);
      setSuccess(`${t('Exportiert:')} ${outPath.split('/').pop()}`);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const openApp = async (tool: 'blockbench' | 'blender') => {
    setErr(null);
    try {
      if (tool === 'blockbench') await hub.threedOpenWindow(projectId);
      else await hub.threedOpenBlender(projectId);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-4 text-[12px]">
      {/* Explicit Tool Settings */}
      <div className="space-y-2 rounded-lumen border border-edge bg-surface/60 p-3">
        <div className="flex items-center gap-2 font-medium text-text">
          <Icon name="lucide:settings-2" size={14} className="text-muted" />
          <span>{t('3D-Einstellungen & Werkzeuge')}</span>
        </div>

        <div className="space-y-2 pt-1">
          <div>
            <label className="text-[11px] font-medium text-subtle">{t('Bevorzugtes 3D-Werkzeug')}</label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <button
                className={cx('flex items-center justify-center gap-1.5 rounded-lumen-sm border p-2 text-left transition-colors', preferredTool === 'blockbench' ? 'border-accent/60 bg-accent/10 font-medium text-accent' : 'border-edge bg-surface text-subtle hover:text-text')}
                onClick={() => setSettings({ threed: { ...threedSettings, preferredTool: 'blockbench' } })}
              >
                <Icon name="lucide:cuboid" size={15} />
                <span>Blockbench</span>
              </button>
              <button
                className={cx('flex items-center justify-center gap-1.5 rounded-lumen-sm border p-2 text-left transition-colors', preferredTool === 'blender' ? 'border-accent/60 bg-accent/10 font-medium text-accent' : 'border-edge bg-surface text-subtle hover:text-text')}
                onClick={() => setSettings({ threed: { ...threedSettings, preferredTool: 'blender' } })}
              >
                <Icon name="lucide:box" size={15} />
                <span>Blender</span>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button className="btn flex-1" onClick={() => void openApp('blockbench')}>
              <Icon name="lucide:cuboid" size={13} />
              <span>{t('In Blockbench öffnen')}</span>
            </button>
            <button className="btn flex-1" onClick={() => void openApp('blender')}>
              <Icon name="lucide:box" size={13} />
              <span>{t('In Blender öffnen')}</span>
            </button>
          </div>
        </div>

        {/* Export settings */}
        <div className="border-t border-edge/60 pt-2.5">
          <label className="text-[11px] font-medium text-subtle">{t('Standard-Exportformat')}</label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {(['glb', 'gltf', 'obj', 'fbx'] as const).map((fmt) => (
              <button
                key={fmt}
                className={cx('rounded-sm px-2.5 py-1 uppercase transition-colors', exportFormat === fmt ? 'bg-active font-medium text-text shadow-xs' : 'border border-edge text-subtle hover:text-text')}
                onClick={() => {
                  setSettings({ threed: { ...threedSettings, defaultExportFormat: fmt } });
                }}
              >
                {fmt}
              </button>
            ))}
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <button
              className="btn btn-primary flex items-center gap-1.5"
              disabled={exporting}
              onClick={() => void handleExport(exportFormat)}
            >
              <Icon name={exporting ? 'lucide:loader' : 'lucide:download'} size={13} className={exporting ? 'animate-spin' : ''} />
              <span>{exporting ? t('Exportiere…') : `${t('Als')} .${exportFormat.toUpperCase()} ${t('exportieren')}`}</span>
            </button>
          </div>
        </div>

        {success && <div className="text-[11.5px] text-ok">{success}</div>}
        {err && <div className="text-[11.5px] text-bad">{err}</div>}
      </div>

      {/* Workfiles Section */}
      <div className="space-y-2 rounded-lumen border border-edge bg-surface/60 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-medium text-text">
            <Icon name="lucide:folder-archive" size={14} className="text-muted" />
            <span>{t('Arbeitsdateien (Workfiles)')}</span>
          </div>
          <button className="icon-btn-sm" title={t('Aktualisieren')} onClick={() => void reload()}>
            <Icon name="lucide:refresh-cw" size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        <p className="text-[11.5px] text-subtle">
          {t('Alle Modelldaten (.bbmodel, .blend), Texturen, Animationen und Exporte dieses Projekts.')}
        </p>

        <div className="space-y-1.5 pt-1">
          {files.length === 0 && !loading && (
            <p className="py-2 text-center text-subtle">{t('Keine Dateien gefunden.')}</p>
          )}

          {files.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-2 rounded-lumen border border-edge/60 bg-base/40 px-2.5 py-2 transition-colors hover:bg-base/70"
            >
              <Icon name={FILE_ICONS[file.type]} size={16} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[11.5px] font-medium text-text">{file.name}</span>
                  <span className="rounded-xs bg-active/60 px-1 text-[9.5px] text-subtle">{file.format?.toUpperCase()}</span>
                </div>
                <div className="text-[10.5px] text-subtle">
                  <span>{TYPE_NAMES[file.type]}</span> · <span>{fmtBytes(file.size)}</span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {file.type === 'bbmodel' && (
                  <button
                    className="icon-btn-sm text-subtle hover:text-text"
                    title={t('In Blockbench öffnen')}
                    onClick={() => void openApp('blockbench')}
                  >
                    <Icon name="lucide:external-link" size={13} />
                  </button>
                )}
                {file.type === 'blend' && (
                  <button
                    className="icon-btn-sm text-subtle hover:text-text"
                    title={t('In Blender öffnen')}
                    onClick={() => void openApp('blender')}
                  >
                    <Icon name="lucide:external-link" size={13} />
                  </button>
                )}
                <button
                  className="icon-btn-sm text-subtle hover:text-text"
                  title={t('Im Ordner zeigen')}
                  onClick={() => void hub.revealPath(file.path)}
                >
                  <Icon name="lucide:folder-open" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
