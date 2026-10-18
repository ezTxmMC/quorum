import { useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDERS } from '@shared/catalog';
import type { ProviderId, ProviderOptions } from '@shared/types';
import { Dot, EffortButton, ModelButton, defaultModel } from '@/components/ModelPicker';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';

interface Choice { provider: ProviderId; options: ProviderOptions; cwd: string }

function load(): Choice | null {
  try { return JSON.parse(localStorage.getItem('quick-choice') ?? 'null'); } catch { return null; }
}

/** Spotlight-artiges Schnell-Prompt-Fenster (Tray/Hotkey). */
export function QuickPage() {
  const settings = useHub((s) => s.data.settings);
  const sessions = useHub((s) => s.data.sessions);
  const hidden = useHub((s) => s.data.hidden);
  const statuses = useHub((s) => s.statuses);
  const recent0 = useHub((s) => s.data.recentProjects[0] ?? '');
  const [prompt, setPrompt] = useState('');
  const [choice, setChoice] = useState<Choice>(() => load() ?? { provider: 'claude', options: {}, cwd: '' });
  const [sel, setSel] = useState(-1);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { document.documentElement.dataset.quick = '1'; }, []);
  useEffect(() => hub.onQuickShow(() => { setPrompt(''); setSel(-1); setTimeout(() => ta.current?.focus(), 30); }), []);
  useEffect(() => { ta.current?.focus(); }, []);
  useEffect(() => { try { localStorage.setItem('quick-choice', JSON.stringify(choice)); } catch { /* ignorieren */ } }, [choice]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }, [prompt]);

  // Standardmodell ergänzen und Projekt vorbelegen
  useEffect(() => {
    const m = choice.options.model ?? defaultModel(choice.provider, statuses[choice.provider]);
    if (m && m !== choice.options.model) setChoice((c) => ({ ...c, options: { ...c.options, model: m } }));
  }, [choice.provider, choice.options.model, statuses]);
  const cwd = choice.cwd || recent0;

  const recents = useMemo(() => sessions.filter((s) => s.messages.length && !hidden.includes(s.cwd)).slice(0, 5), [sessions, hidden]);
  const showRecents = !prompt.trim() && recents.length > 0;

  const submit = () => {
    const p = prompt.trim();
    if (!p) return;
    const base = settings.providerDefaults[choice.provider] ?? {};
    void hub.quickSubmit({ provider: choice.provider, cwd, options: { ...base, ...choice.options }, prompt: p });
    setPrompt('');
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); void hub.quickHide(); return; }
    if (showRecents && e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(recents.length - 1, s + 1)); return; }
    if (showRecents && e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(-1, s - 1)); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (showRecents && sel >= 0) void hub.quickOpenChat(recents[sel].id); else submit();
    }
  };

  return (
    <div className="h-full p-3" onKeyDown={(e) => e.key === 'Escape' && void hub.quickHide()}>
      <div className="quick-card overflow-hidden rounded-[22px] border border-edge-strong shadow-2xl">
        <div className="flex items-start gap-3 px-5 pb-2 pt-4">
          <Icon name="lucide:sparkles" size={22} className="mt-1 shrink-0 text-accent" />
          <textarea ref={ta} rows={1} value={prompt} autoFocus onChange={(e) => { setPrompt(e.target.value); setSel(-1); }} onKeyDown={onKey}
            placeholder={t('Frag etwas oder gib eine Aufgabe …')} className="max-h-[150px] w-full resize-none bg-transparent text-[20px] leading-snug outline-none placeholder:text-subtle" />
        </div>
        <div className="flex items-center gap-1 px-3 pb-3">
          <ModelButton down compact provider={choice.provider} model={choice.options.model}
            onPick={(provider, model) => setChoice((c) => ({ ...c, provider, options: provider === c.provider ? { ...c.options, model } : { ...settings.providerDefaults[provider], model } }))} />
          <EffortButton down provider={choice.provider} model={choice.options.model} value={choice.options.effort} onChange={(effort) => setChoice((c) => ({ ...c, options: { ...c.options, effort } }))} />
          <button className="btn btn-ghost !px-2 text-muted" title={cwd || t('Ordner wählen')} onClick={async () => { const d = await hub.pickFolder(); if (d) setChoice((c) => ({ ...c, cwd: d })); }}>
            <Icon name="lucide:folder-open" size={14} /><span className="max-w-36 truncate text-[12px]">{cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : t('Ordner wählen')}</span>
          </button>
          <div className="flex-1" />
          <span className="mr-2 text-[11px] text-subtle">↵ {t('Senden')} · Esc</span>
          <button className="grid size-8 place-items-center rounded-full bg-accent text-accent-fg transition-transform enabled:hover:scale-105 disabled:opacity-35" disabled={!prompt.trim()} onClick={submit}><Icon name="lucide:arrow-up" size={16} /></button>
        </div>
        {showRecents && (
          <div className="border-t border-edge p-1.5">
            <div className="px-2.5 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Zuletzt')}</div>
            {recents.map((s, i) => (
              <button key={s.id} className={`flex w-full items-center gap-2.5 rounded-lumen-sm px-2.5 py-2 text-left transition-colors hover:bg-hover ${i === sel ? 'bg-active' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => void hub.quickOpenChat(s.id)}>
                <Dot id={s.provider} /><span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="text-[11px] text-subtle">{PROVIDERS[s.provider].name.split(' ')[0]}{s.cwd ? ` · ${s.cwd.split(/[\\/]/).filter(Boolean).pop()}` : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
