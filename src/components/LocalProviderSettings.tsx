import { useEffect, useState } from 'react';
import type { RuntimeDetection } from '@shared/models';
import type { ResourceSnapshot } from '../../electron/runtimes/resources';
import { hub } from '@/lib/api';
import { useHub } from '@/lib/store';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { Label, Toggle, cx } from './ui';
import { LocalModelManagement } from './LocalModelManagement';
import { OptionsPanel } from './OptionsPanel';
const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
const pct = (a: number, b: number) => b > 0 ? Math.min(100, a / b * 100) : 0;
function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11.5px] text-subtle"><span>{label}</span><span>{Math.round(value)} %</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-hover"><div className="h-full bg-accent transition-[width]" style={{ width: `${value}%` }} /></div>
    </div>
  );
}

function RuntimeCard({ rt, res }: { rt?: RuntimeDetection; res?: ResourceSnapshot }) {
  return (
    <section className="rounded-lumen-lg border border-edge bg-surface p-4">
      <div className="mb-3 flex items-center gap-3">
        <Icon name="lucide:cpu" size={18} className="text-muted" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">llama.cpp <span className="font-normal text-subtle">· GGUF</span></div>
          <div className="truncate font-mono text-[11.5px] text-subtle">
            {rt?.available ? `${rt.version ?? ''} · Backends: ${rt.backends.join(', ')}` : rt?.error ?? t('Prüfe Installation …')}
          </div>
        </div>
        <span className={cx('rounded-full px-2.5 py-0.5 text-[11.5px]', rt?.available ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad')}>{rt?.available ? t('bereit') : t('fehlt')}</span>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {res?.gpu ? (
          <div className="col-span-1">
            <Bar value={pct(res.gpu.vramUsed, res.gpu.vramTotal)} label={`VRAM ${gb(res.gpu.vramUsed)} / ${gb(res.gpu.vramTotal)} GB`} />
            {res.gpu.busyPercent !== undefined && <div className="mt-2"><Bar value={res.gpu.busyPercent} label={t('GPU-Auslastung')} /></div>}
          </div>
        ) : (
          <div className="col-span-1 text-[11.5px] text-subtle">{t('Keine GPU-Daten')}</div>
        )}
        <div className="col-span-1"><Bar value={res ? pct(res.ram.used, res.ram.total) : 0} label={res ? `RAM ${gb(res.ram.used)} / ${gb(res.ram.total)} GB` : 'RAM'} /></div>
        <div className="col-span-1"><Bar value={res ? Math.min(100, (res.cpu.load1 / res.cpu.cores) * 100) : 0} label={`CPU · ${res?.cpu.cores ?? '–'} ${t('Kerne')}`} /></div>
      </div>
    </section>
  );
}


export function LocalProviderSettings({ onApi }: { onApi?: () => void }) {
  const settings = useHub((s) => s.data.settings);
  const [rt, setRt] = useState<RuntimeDetection>();
  const [res, setRes] = useState<ResourceSnapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => { setBusy(true); setError(''); try { const [runtime, resources] = await Promise.all([hub.modelRuntime(), hub.modelResources()]); setRt(runtime); setRes(resources); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  useEffect(() => {
    let alive = true;
    void hub.modelRuntime().then((v) => { if (alive) setRt(v); }).catch((e) => { if (alive) setError(String(e)); });
    const tick = () => void hub.modelResources().then((v) => { if (alive) setRes(v); }).catch(() => {});
    tick(); const timer = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const set = useHub.getState().setSettings;
  const runtime = settings.localRuntime ?? {};
  const configure = (patch: Partial<typeof runtime>) => set({ localRuntime: { ...runtime, ...patch } });
  return <div className="space-y-4">
    <RuntimeCard rt={rt} res={res} />
    {onApi && <button className="btn" onClick={onApi}><Icon name="lucide:cloud" size={14} />{t('Bestehenden Server nur per API verbinden')}</button>}
    <Label hint={t('Gilt für neu gestartete Modelle')}>{t('Pfad zu llama-server')}</Label>
    <div className="flex gap-2"><input className="field font-mono text-[12px]" value={settings.llamaBinary ?? ''} placeholder="llama-server" onChange={(e) => set({ llamaBinary: e.target.value || undefined })} /><button className="btn" onClick={async () => { const [f] = await hub.pickFiles('any'); if (f) set({ llamaBinary: f }); }}><Icon name="lucide:file-search" size={14} /></button><button className="btn" disabled={busy} onClick={() => void refresh()}><Icon name="lucide:refresh-cw" size={14} /></button></div>
    <div className="grid grid-cols-2 gap-3">
      <div><Label>{t('Entladen nach Leerlauf (Minuten)')}</Label><input className="field" type="number" min={1} max={1440} value={runtime.idleMinutes ?? 10} onChange={(e) => configure({ idleMinutes: Math.max(1, Math.min(1440, Number(e.target.value) || 10)) })} /></div>
      <div><Label>{t('Freier GPU-Speicher (MiB)')}</Label><input className="field" type="number" min={0} max={65536} step={128} value={runtime.vramReserveMb ?? 512} onChange={(e) => configure({ vramReserveMb: Math.max(0, Math.min(65536, Number(e.target.value))) })} /></div>
    </div>
    <Toggle checked={runtime.cpuFallback !== false} onChange={(cpuFallback) => configure({ cpuFallback })} label={t('CPU-Fallback bei GPU-Speichermangel')} />
    <p className="text-[11px] text-subtle">{t('Backend, GPU-Schichten und Kontextgröße lassen sich unten pro Modell einstellen.')}</p>
    {error && <p className="text-bad">{error}</p>}
    <LocalModelManagement runtime={rt} />
    <OptionsPanel provider="local" value={settings.providerDefaults.local} onChange={(patch) => useHub.getState().setProviderDefaults('local', patch)} />
  </div>;
}
