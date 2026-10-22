import { useEffect, useState } from 'react';
import type { Backend, ModelRecord, RuntimeDetection } from '@shared/models';
import type { LoadedInfo } from '../../electron/runtimes/scheduler';
import { hub } from '@/lib/api';
import { useHub } from '@/lib/store';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { Label, Select } from './ui';

function ModelRow({ model, loaded, backends, busy, act }: { model: ModelRecord; loaded?: LoadedInfo; backends: Backend[]; busy: boolean; act: (operation: () => Promise<unknown>) => Promise<void> }) {
  const [load, setLoad] = useState(model.load ?? {});
  useEffect(() => { setLoad(model.load ?? {}); }, [model.id, model.load]);
  return <div className="space-y-3 rounded-lumen border border-edge p-3">
    <div><div className="flex justify-between gap-2"><span className="min-w-0 truncate font-medium">{model.name}</span><span className="shrink-0 text-[11px] text-subtle">{loaded ? `${t('geladen')} · ${loaded.backend}` : t('Entladen')}</span></div><div title={model.path} className="truncate font-mono text-[10px] text-subtle">{model.path}</div></div>
    <div className="grid grid-cols-3 gap-2">
      <div><Label>Backend</Label><Select value={load.backend} placeholder={t('Auto')} options={[...new Set([...(load.backend ? [load.backend] : []), ...backends])].map((value) => ({ value, label: value.toUpperCase() }))} onChange={(backend) => setLoad({ ...load, backend: backend || undefined })} /></div>
      <div><Label>{t('GPU-Schichten')}</Label><input className="field" type="number" min={0} placeholder={t('Auto')} value={load.gpuLayers ?? ''} onChange={(e) => setLoad({ ...load, gpuLayers: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} /></div>
      <div><Label>{t('Kontextgröße')}</Label><input className="field" type="number" min={512} step={512} placeholder={t('Auto')} value={load.contextSize ?? ''} onChange={(e) => setLoad({ ...load, contextSize: e.target.value === '' ? undefined : Math.max(512, Number(e.target.value)) })} /></div>
    </div>
    <div className="flex flex-wrap gap-2"><button className="btn text-[11px]" disabled={busy} onClick={() => void act(() => hub.modelConfig(model.id, load))}>{t('Parameter speichern')}</button><button className="btn text-[11px]" disabled={busy || !!loaded?.inUse} onClick={() => void act(async () => { if (loaded) { if (!await hub.modelUnload(model.id)) throw new Error(t('Modell wird gerade verwendet.')); } else { await hub.modelConfig(model.id, load); await hub.modelLoad(model.id); } })}>{loaded ? t('Entladen') : t('Laden / starten')}</button><button className="btn text-[11px] text-muted" disabled={busy || !!loaded?.inUse} onClick={() => void act(() => hub.modelForget(model.id))}>{t('Aus Liste entfernen')}</button></div>
    {!!loaded?.inUse && <p className="text-[11px] text-subtle">{t('Modell wird gerade verwendet.')}</p>}
  </div>;
}

export function LocalModelManagement({ runtime }: { runtime?: RuntimeDetection }) {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [loaded, setLoaded] = useState<LoadedInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => { const [all, active] = await Promise.all([hub.models(), hub.modelLoaded()]); setModels(all.filter((m) => m.format === 'gguf')); setLoaded(active); await useHub.getState().refreshStatus('local', true); };
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(''); try { await operation(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  useEffect(() => { let alive = true; const reload = () => { if (alive) void refresh().catch((e) => setError(String(e))); }; reload(); const off = hub.onModelRegistry(reload); const events = hub.onModelEvent(reload); return () => { alive = false; off(); events(); }; }, []);
  return <section className="space-y-3 border-t border-edge pt-4">
    <div className="flex items-center justify-between"><h3 className="font-medium">{t('Lokale GGUF-Modelle')}</h3><button className="btn" disabled={busy} onClick={() => void act(async () => { const [path] = await hub.pickFiles('any'); if (path) { if (!/\.gguf$/i.test(path)) throw new Error(t('Bitte eine GGUF-Datei wählen.')); await hub.modelImport(path); } })}><Icon name="lucide:folder-plus" size={13} />{t('GGUF importieren')}</button></div>
    <p className="text-[11px] text-subtle">{t('Parameter gelten beim nächsten Start. Entfernen aus der Liste behält die Modelldateien.')}</p>
    {models.map((model) => <ModelRow key={model.id} model={model} loaded={loaded.find((m) => m.modelId === model.id)} backends={runtime?.backends ?? ['cpu']} busy={busy} act={act} />)}
    {!models.length && <p className="text-[12px] text-subtle">{t('Noch keine GGUF-Modelle importiert.')}</p>}
    {error && <p role="alert" className="text-[12px] text-bad">{t(error)}</p>}
  </section>;
}
