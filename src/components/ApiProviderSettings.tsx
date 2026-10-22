import { useEffect, useState } from 'react';
import { apiBaseUrl, type ApiConnection } from '@shared/connections';
import { hub, uid } from '@/lib/api';
import { useHub } from '@/lib/store';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { Label, Toggle, cx } from './ui';
import { OptionsPanel } from './OptionsPanel';

const empty = (): ApiConnection => ({ id: uid(), name: '', baseUrl: '', enabled: true, models: [] });
export function ApiProviderSettings() {
  const settings = useHub((s) => s.data.settings);
  const connections = settings.apiConnections ?? [];
  const status = useHub((s) => s.statuses.api);
  const [draft, setDraft] = useState<ApiConnection>(empty);
  const [models, setModels] = useState('');
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { let alive = true; void hub.apiHasKey(draft.id).then((value) => { if (alive) setHasKey(value); }).catch(() => { if (alive) setHasKey(false); }); return () => { alive = false; }; }, [draft.id]);
  const edit = (connection: ApiConnection) => { setDraft(connection); setModels(connection.models.join('\n')); setKey(''); setMessage(''); setError(''); };
  const connection = () => ({ ...draft, name: draft.name.trim(), baseUrl: apiBaseUrl(draft.baseUrl.trim()), models: [...new Set(models.split('\n').map((m) => m.trim()).filter(Boolean))] });
  const act = async (operation: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await operation(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const storeKey = async () => {
    if (!key.trim()) return '';

    const result = await hub.apiSetKey(draft.id, key.trim());
    setKey(''); setHasKey(true);
    const notice = result.persistent ? '' : t('API-Key ist für diese Sitzung verfügbar; kein sicherer Schlüsselspeicher vorhanden.');
    if (notice) setMessage(notice);
    return notice;
  };
  const save = async () => {
    const value = connection();
    if (!value.name) throw new Error(t('Bitte einen Namen eingeben.'));
    await storeKey();
    const current = useHub.getState().data.settings.apiConnections ?? [];
    useHub.getState().setSettings({ apiConnections: [...current.filter((c) => c.id !== value.id), value] });
    await hub.save(useHub.getState().data);
    setDraft(value);
    await useHub.getState().refreshStatus('api', true);
  };
  return <div className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-[16px] font-semibold">API</h2><button className="btn" disabled={busy} onClick={() => edit(empty())}><Icon name="lucide:plus" size={13} />{t('API hinzufügen')}</button></div>
    <p className="text-[12px] text-muted">{t('OpenAI-kompatible API verbinden: Basis-URL inklusive /v1, optionaler API-Key und Modell-IDs. Ohne lokale Installation.')}</p>
    <div className="flex flex-wrap gap-2">{connections.map((c) => <button key={c.id} className={cx('btn', c.id === draft.id && 'border-accent text-accent')} disabled={busy} onClick={() => edit(c)}>{c.name}{!c.enabled && ` · ${t('Aus')}`}</button>)}</div>
    <div className="grid grid-cols-2 gap-3"><div><Label>{t('Name')}</Label><input className="field" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Local server" /></div><div><Label>{t('Basis-URL')}</Label><input className="field" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="http://127.0.0.1:8080/v1" /></div></div>
    <div><Label hint={hasKey ? t('Key vorhanden; leer lassen zum Beibehalten') : t('Optional bei lokalen Servern')}>API Key</Label><input className="field" type="password" autoComplete="new-password" value={key} onChange={(e) => setKey(e.target.value)} />{hasKey && <button disabled={busy} className="mt-1 text-[11px] text-muted hover:text-bad" onClick={() => void act(async () => { await hub.apiSetKey(draft.id, ''); setHasKey(false); })}>{t('Gespeicherten Key entfernen')}</button>}</div>
    <div><Label hint={t('Eine Modell-ID pro Zeile')}>{t('Manuelle Modelle')}</Label><textarea className="field min-h-20 resize-y font-mono text-[12px]" value={models} onChange={(e) => setModels(e.target.value)} /><p className="mt-1 text-[11px] text-subtle">{t('Für Dienste ohne Modellliste können Modell-IDs manuell eingetragen werden.')}</p></div>
    <Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('Verbindung aktivieren')} />
    <div className="flex flex-wrap gap-2"><button className="btn btn-primary" disabled={busy} onClick={() => void act(save)}>{t('Speichern')}</button><button className="btn" disabled={busy || !draft.baseUrl} onClick={() => void act(async () => { const value = connection(); const notice = await storeKey(); const discovered = await hub.apiInspect(value); setModels([...new Set([...value.models, ...discovered])].join('\n')); setMessage([t('Verbindung erfolgreich. Modelle übernommen; zum Übernehmen speichern.'), notice].filter(Boolean).join(' ')); })}>{t('Verbindung testen & Modelle laden')}</button>{connections.some((c) => c.id === draft.id) && <button className="btn text-bad" disabled={busy} onClick={() => void act(async () => { await hub.apiSetKey(draft.id, ''); useHub.getState().setSettings({ apiConnections: (useHub.getState().data.settings.apiConnections ?? []).filter((c) => c.id !== draft.id) }); await hub.save(useHub.getState().data); edit(empty()); await useHub.getState().refreshStatus('api', true); })}>{t('Verbindung entfernen')}</button>}</div>
    {message && <p role="status" className="text-[12px] text-muted">{t(message)}</p>}{error && <p role="alert" className="text-[12px] text-bad">{t(error)}</p>}
    {status?.error && <p className="whitespace-pre-wrap text-[11px] text-warn">{t(status.error)}</p>}
    <OptionsPanel provider="api" value={settings.providerDefaults.api} onChange={(patch) => useHub.getState().setProviderDefaults('api', patch)} />
  </div>;
}
