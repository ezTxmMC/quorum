import { useEffect, useState } from 'react';
import type { OllamaManagement, OllamaPull } from '@shared/connections';
import { apiBaseUrl } from '@shared/connections';
import { hub } from '@/lib/api';
import { useHub } from '@/lib/store';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { Label, Select, cx } from './ui';
import { OptionsPanel } from './OptionsPanel';

export function OllamaProviderSettings() {
  const settings = useHub((s) => s.data.settings);
  const status = useHub((s) => s.statuses.ollama);
  const [draft, setDraft] = useState(settings.ollama ?? { mode: 'local' as const, host: 'http://127.0.0.1:11434' });
  const [state, setState] = useState<OllamaManagement>();
  const [pulls, setPulls] = useState<OllamaPull[]>([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState('');
  const refresh = async () => {
    const [management] = await Promise.all([hub.ollamaManage(), useHub.getState().refreshStatus('ollama', true)]);
    setState(management);
  };
  const act = async (operation: () => Promise<unknown>, reread = true) => {
    setBusy(true); setError('');
    try { await operation(); if (reread) await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => {
    let alive = true;
    void hub.ollamaManage().then((value) => { if (alive) setState(value); }).catch(() => {});
    void hub.ollamaPulls().then((value) => { if (alive) setPulls(value); }).catch(() => {});
    const off = hub.onOllamaProgress((progress) => {
      if (!alive) return;
      setPulls((list) => [...list.filter((p) => p.id !== progress.id), progress]);
      if (progress.status === 'done') void refresh().catch((e) => setError(String(e)));
    });
    return () => { alive = false; off(); };
  }, []);
  const save = async () => {
    const host = draft.host?.trim() ? apiBaseUrl(draft.host) : undefined;
    if (state?.owned && host && host !== state.host) throw new Error(t('Zuerst den von Quorum gestarteten Server stoppen.'));
    useHub.getState().setSettings({ ollama: { ...draft, host } });
    await hub.save(useHub.getState().data);
  };
  return <div className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-[16px] font-semibold">Ollama</h2><span className={cx('text-[12px]', status?.installed ? 'text-ok' : 'text-subtle')}>{status?.version ?? t('Nicht verbunden')}</span></div>
    <div className="grid grid-cols-2 gap-3">
      <div><Label>{t('Betrieb')}</Label><Select value={draft.mode ?? 'local'} onChange={(mode) => setDraft({ ...draft, mode })} options={[{ value: 'local', label: t('Lokal verwalten') }, { value: 'api', label: t('Nur API verbinden') }]} /></div>
      <div><Label>API URL</Label><input className="field" placeholder="http://127.0.0.1:11434" value={draft.host ?? ''} onChange={(e) => setDraft({ ...draft, host: e.target.value })} /></div>
    </div>
    {draft.mode !== 'api' && <div><Label>{t('Pfad zur Ollama-CLI')}</Label><div className="flex gap-2"><input className="field font-mono text-[12px]" placeholder="ollama" value={draft.binary ?? ''} onChange={(e) => setDraft({ ...draft, binary: e.target.value })} /><button className="btn" onClick={async () => { const [binary] = await hub.pickFiles('any'); if (binary) setDraft({ ...draft, binary }); }}><Icon name="lucide:file-search" size={14} /></button></div></div>}
    <div className="flex flex-wrap gap-2">
      <button className="btn" disabled={busy} onClick={() => void act(save)}>{t('Speichern & verbinden')}</button>
      <button className="btn" disabled={busy} onClick={() => void act(async () => {})}><Icon name="lucide:refresh-cw" size={13} />{t('Aktualisieren')}</button>
      {draft.mode !== 'api' && <><button className="btn" disabled={busy || !!state?.owned} onClick={() => void act(async () => { await save(); await hub.ollamaStart(); })}>{t('Server starten')}</button><button className="btn text-bad" disabled={busy || !state?.owned} onClick={() => void act(async () => { await hub.ollamaStop(); setState(undefined); await useHub.getState().refreshStatus('ollama', true); }, false)}>{t('Server stoppen')}</button></>}
    </div>
    <p className="text-[11px] text-subtle">{state?.owned ? t('Server von Quorum gestartet.') : t('Bereits laufende oder externe Server werden nur über ihre API verwaltet.')}</p>
    <div className="rounded-lumen border border-edge p-3 space-y-2">
      <Label>{t('Ollama-Modell herunterladen')}</Label>
      <div className="flex gap-2"><input className="field" placeholder="qwen3:8b" value={model} onChange={(e) => setModel(e.target.value)} /><button className="btn" disabled={busy || !model.trim()} onClick={() => void act(async () => { await hub.ollamaPull(model.trim()); setModel(''); })}>{t('Herunterladen')}</button></div>
      {pulls.map((pull) => <div key={pull.id} className="space-y-1 text-[11px]"><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{pull.model} · {pull.detail}</span>{pull.status === 'running' && <button className="icon-btn !size-5 text-bad" title={t('Download abbrechen')} onClick={() => void hub.ollamaCancelPull(pull.id)}><Icon name="lucide:square" size={11} /></button>}</div>{pull.status === 'running' && !!pull.total && <progress className="w-full accent-[var(--c-accent)]" max={pull.total} value={pull.completed ?? 0} />}</div>)}
    </div>
    <div className="space-y-2">
      {(state?.models ?? []).map((item) => <div key={item.name} className="rounded-lumen border border-edge px-3 py-2">
        <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[12px]" title={item.name}>{item.name}</span><span className="text-[10px] text-subtle">{(item.size / 1024 ** 3).toFixed(1)} GB{item.loaded ? ` · ${t('geladen')}` : ''}</span></div>
        <div className="mt-2 flex flex-wrap gap-2"><button className="btn text-[11px]" disabled={busy} onClick={() => void act(() => hub.ollamaAction(item.loaded ? 'unload' : 'load', item.name))}>{item.loaded ? t('Entladen') : t('Laden')}</button><button className="btn text-[11px] text-bad" disabled={busy} onClick={() => { if (confirm !== item.name) { setConfirm(item.name); return; } setConfirm(''); void act(() => hub.ollamaAction('delete', item.name)); }}>{confirm === item.name ? t('Löschen bestätigen') : t('Modell löschen')}</button>{confirm === item.name && <button className="btn text-[11px]" onClick={() => setConfirm('')}>{t('Abbrechen')}</button>}</div>
      </div>)}
      {state && !state.models.length && <p className="text-subtle">{t('Keine Modelle installiert.')}</p>}
    </div>
    {error && <p role="alert" className="whitespace-pre-wrap text-[12px] text-bad">{error}</p>}
    <OptionsPanel provider="ollama" value={settings.providerDefaults.ollama} onChange={(patch) => useHub.getState().setProviderDefaults('ollama', patch)} />
  </div>;
}
