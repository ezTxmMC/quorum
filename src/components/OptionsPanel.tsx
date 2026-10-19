import { chatMode } from '@shared/chat-modes';
import { t } from '@/lib/i18n';
import { useState } from 'react';
import { PROVIDERS, isTextOnly, modelEfforts, modesFor, modeLabel, currentMode, modePatch, effortLabel, canonicalModel, modelChoices, selectModelOptions } from '@shared/catalog';
import type { ProviderId, ProviderOptions } from '@shared/types';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { ModelButton } from './ModelPicker';
import { Collapse, Label, Select, Toggle } from './ui';

interface Props {
  provider: ProviderId;
  value: ProviderOptions;
  onChange: (patch: ProviderOptions) => void;
  /** Reduziert auf die wichtigsten Felder (für Agenten-Karten). */
  basic?: boolean;
  allowImages?: boolean;
}

function Lines({ value, onChange, placeholder }: { value: string[] | undefined; onChange: (v: string[]) => void; placeholder: string }) {
  return <textarea className="field min-h-14 resize-y font-mono text-[12px]" placeholder={placeholder} value={(value ?? []).join('\n')} onChange={(e) => onChange(e.target.value.split('\n').filter((l) => l.trim() !== '' || e.target.value.endsWith('\n')))} />;
}

export function OptionsPanel({ provider, value, onChange, basic, allowImages }: Props) {
  const meta = PROVIDERS[provider];
  const coding = chatMode(value) === 'coding';
  const statuses = useHub((s) => s.statuses);
  const [more, setMore] = useState(false);
  const custom = useHub((s) => s.data.settings.customModels?.[provider]);
  const models = modelChoices(provider, statuses, custom, allowImages);
  const id = canonicalModel(provider, value.model);
  const model = models.find((m) => m.id === id) ?? models[0];
  const efforts = value.imageGen ? [] : modelEfforts(provider, model).map((v) => ({ value: v, label: t(effortLabel(provider, v)) }));

  const pickFile = async (key: 'mcpConfig' | 'jsonSchema') => {
    const [f] = await hub.pickFiles('json');
    if (f) onChange({ [key]: f });
  };
  const addDir = async () => {
    const d = await hub.pickFolder();
    if (d) onChange({ addDirs: [...(value.addDirs ?? []), d] });
  };

  return (
    <div className="space-y-3.5">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{t('Modell')}</Label>
          <ModelButton field down onlyProvider={provider} provider={provider} model={value.model} imageGen={value.imageGen} includeImages={allowImages}
            onPick={(_provider, selected, imageGen) => onChange(selectModelOptions(value, selected, models.find((m) => m.id === selected), imageGen))} />
        </div>
        {efforts.length > 0 && <div>
          <Label>{t('Effort')}</Label>
          <Select value={value.effort} onChange={(v) => onChange({ effort: v || undefined })} options={efforts} placeholder={t('Standard')} />
        </div>}
      </div>
      {coding && modesFor(provider).length > 0 && <div>
        <Label>{t('Berechtigungen')}</Label>
        <Select value={currentMode(provider, value)} onChange={(mode) => onChange(modePatch(provider, mode))} options={[...new Set([currentMode(provider, value), ...modesFor(provider)])].map((id) => ({ value: id, label: t(modeLabel(provider, id)) }))} />
        <p className="mt-1 text-[11px] text-subtle">{t('Ask-Modi: Rückfragen werden im Headless-Betrieb abgelehnt. Für Änderungen einen passenden Modus wählen.')}</p>
      </div>}

      {!basic && !value.imageGen && (
        <>
          <div>
            <Label>{t('System-Prompt / Zusatzanweisungen')}</Label>
            <textarea className="field min-h-16 resize-y" placeholder={provider === 'claude' ? t('Wird an den System-Prompt angehängt') : provider === 'codex' ? t('Wird als Entwickleranweisung übergeben') : isTextOnly(provider) ? t('Wird als Systemnachricht übergeben') : t('Wird dem Prompt vorangestellt')} value={value.systemPrompt ?? ''} onChange={(e) => onChange({ systemPrompt: e.target.value || undefined })} />
          </div>
          {coding && !isTextOnly(provider) && <div>
            <Label>{t('Zusätzliche Verzeichnisse')}</Label>
            <div className="space-y-1">
              {(value.addDirs ?? []).map((d, i) => (
                <div key={d} className="flex items-center gap-2 rounded-lumen-sm bg-input px-2 py-1 font-mono text-[11.5px]">
                  <span className="flex-1 truncate">{d}</span>
                  <button className="icon-btn !size-5" onClick={() => onChange({ addDirs: (value.addDirs ?? []).filter((_, j) => j !== i) })}><Icon name="lucide:x" size={12} /></button>
                </div>
              ))}
              <button className="btn btn-ghost !px-1 text-muted" onClick={addDir}><Icon name="lucide:folder-plus" /> {t('Verzeichnis hinzufügen')}</button>
            </div>
          </div>}
        </>
      )}

      {!basic && coding && !isTextOnly(provider) && (
        <button className="flex items-center gap-1.5 text-[12px] text-muted hover:text-fg" onClick={() => setMore((m) => !m)}>
          <Icon name={more ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={14} /> {t('Erweiterte')} {meta.name} {t('Optionen')}
        </button>
      )}
      {!basic && coding && !isTextOnly(provider) && (
        <Collapse open={more}>
        <div className="space-y-3.5 border-l-2 border-edge py-1 pl-3">
          {provider === 'claude' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div><Label hint={t('z. B. Bash(git *) Edit')}>{t('Erlaubte Tools')}</Label><input className="field" value={value.allowedTools ?? ''} onChange={(e) => onChange({ allowedTools: e.target.value || undefined })} /></div>
                <div><Label>{t('Verbotene Tools')}</Label><input className="field" value={value.disallowedTools ?? ''} onChange={(e) => onChange({ disallowedTools: e.target.value || undefined })} /></div>
              </div>
              <div>
                <Label>{t('MCP-Konfiguration (JSON-Datei)')}</Label>
                <div className="flex gap-2"><input className="field" value={value.mcpConfig ?? ''} onChange={(e) => onChange({ mcpConfig: e.target.value || undefined })} /><button className="btn" onClick={() => pickFile('mcpConfig')}><Icon name="lucide:file-json" /></button></div>
              </div>
              <div><Label hint='{"reviewer":{"description":"…","prompt":"…"}}'>{t('Sub-Agenten (JSON)')}</Label><textarea className="field min-h-14 font-mono text-[12px]" value={value.agentsJson ?? ''} onChange={(e) => onChange({ agentsJson: e.target.value || undefined })} /></div>
              <div><Label>{t('Budget-Limit (USD)')}</Label><input type="number" min={0} step={0.5} className="field" value={value.maxBudgetUsd ?? ''} onChange={(e) => onChange({ maxBudgetUsd: e.target.value ? Number(e.target.value) : undefined })} /></div>
              <Toggle checked={value.liveInput !== false} onChange={(v) => onChange({ liveInput: v ? undefined : false })} label={t('Direkte Nachrichten während eines Laufs')} hint={t('Claude nimmt neue Nachrichten mitten im Lauf an (experimentell) – aus: nur Warteschlange')} />
              <Toggle checked={value.chrome === true} onChange={(v) => onChange({ chrome: v ? true : undefined })} label={t('Claude in Chrome')} hint={t('Browser-Steuerung über die Chrome-Erweiterung')} />
              <Toggle checked={!!value.worktree} onChange={(v) => onChange({ worktree: v })} label={t('Eigener Git-Worktree (-w)')} />
            </>
          )}
          {provider === 'codex' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>{t('Profil')}</Label><input className="field" value={value.profile ?? ''} onChange={(e) => onChange({ profile: e.target.value || undefined })} /></div>
                <div><Label>{t('Lokaler Anbieter')}</Label><Select value={value.localProvider} onChange={(v) => onChange({ localProvider: v || undefined })} options={[{ value: 'ollama', label: 'Ollama' }, { value: 'lmstudio', label: 'LM Studio' }]} placeholder="–" /></div>
              </div>
              <div><Label hint={t('key=value, eine pro Zeile')}>{t('Config-Overrides (-c)')}</Label><Lines value={value.configOverrides} onChange={(v) => onChange({ configOverrides: v })} placeholder={'model_provider="openai"\nshell_environment_policy.inherit=all'} /></div>
              <div>
                <Label>{t('Output-Schema (JSON-Datei)')}</Label>
                <div className="flex gap-2"><input className="field" value={value.jsonSchema ?? ''} onChange={(e) => onChange({ jsonSchema: e.target.value || undefined })} /><button className="btn" onClick={() => pickFile('jsonSchema')}><Icon name="lucide:file-json" /></button></div>
              </div>
              <Toggle checked={!!value.oss} onChange={(v) => onChange({ oss: v })} label={t('Open-Source-Modelle (--oss)')} />
              <Toggle checked={!!value.worktree} onChange={(v) => onChange({ worktree: v })} label={t('Eigener Git-Worktree')} />
            </>
          )}
          {provider === 'antigravity' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>{t('Projekt')}</Label><input className="field" value={value.project ?? ''} onChange={(e) => onChange({ project: e.target.value || undefined })} /></div>
                <div><Label>Agent</Label><input className="field" value={value.agent ?? ''} onChange={(e) => onChange({ agent: e.target.value || undefined })} /></div>
              </div>
              <div>
                <Label>{t('JSON-Schema (Datei oder inline)')}</Label>
                <div className="flex gap-2"><input className="field" value={value.jsonSchema ?? ''} onChange={(e) => onChange({ jsonSchema: e.target.value || undefined })} /><button className="btn" onClick={() => pickFile('jsonSchema')}><Icon name="lucide:file-json" /></button></div>
              </div>
              <Toggle checked={!!value.sandboxTerminal} onChange={(v) => onChange({ sandboxTerminal: v })} label={t('Terminal-Sandbox (--sandbox)')} />
            </>
          )}
          <Toggle checked={!!value.ephemeral} onChange={(v) => onChange({ ephemeral: v })} label={t('Ephemere Session')} hint={provider === 'antigravity' ? t('Von dieser CLI nicht unterstützt') : t('Verlauf nicht auf der Platte speichern')} />
          <div><Label hint={t('roh an die CLI durchgereicht')}>{t('Zusätzliche Argumente')}</Label><input className="field font-mono text-[12px]" value={value.extraArgs ?? ''} onChange={(e) => onChange({ extraArgs: e.target.value || undefined })} /></div>
        </div>
        </Collapse>
      )}
    </div>
  );
}
