import { getLang, t } from '@/lib/i18n';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { DIRECT_MESSAGES, PROVIDERS, isChatModel, canonicalModel, selectModelOptions, modelChoices, imageEngines } from '@shared/catalog';
import type { Attachment, ChatMode, ChatSession } from '@shared/types';
import { hub, uid } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { ModeButton, ModelButton, TuneButton, defaultModel } from './ModelPicker';
import { chatMode, switchChatMode } from '@shared/chat-modes';
import { ChatModeButton } from './ChatModeButton';
import { ComposerUsage } from './ComposerUsage';
import { FallbackButton } from './FallbackModels';
import { cx } from './ui';

function arrayToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

interface Props {
  session: ChatSession;
  running: boolean;
  onSend: (text: string, images: string[], mode: 'direct' | 'queue', attachments: Attachment[]) => void;
  onStop: () => void;
  onCommand: (cmd: string, arg: string) => boolean;
}

const BUILTIN = [
  { name: 'new', desc: 'Neuer Chat im selben Projekt' },
  { name: 'plan', desc: 'Plan-Modus ein/aus (nur lesen)' },
  { name: 'provider', desc: '/provider claude | codex | agy' },
  { name: 'model', desc: '/model <name> – Modell wechseln' },
  { name: 'effort', desc: '/effort low|medium|high|xhigh|max' },
  { name: 'review', desc: 'Änderungen im Projekt prüfen (Codex: nativer Review)' },
  { name: 'continue', desc: 'Letzte CLI-Session fortsetzen' },
  { name: 'fork', desc: 'Aktuelle Session verzweigen und weitermachen' },
  { name: 'diff', desc: 'Änderungsübersicht öffnen' },
  { name: 'compact', desc: 'Verlauf zusammenfassen und kompaktieren' },
];

/** Entwürfe je Chat: beim Wechsel zwischen Chats geht getippter Text nicht verloren und landet nicht im falschen Chat. */
const drafts = new Map<string, string>();

function ComposerInner({ session, running, onSend, onStop, onCommand }: Props) {
  const [text, setText] = useState(() => drafts.get(session.id) ?? '');
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => { const id = session.id; return () => { if (textRef.current.trim()) drafts.set(id, textRef.current); else drafts.delete(id); }; }, [session.id]);
  const msgCount = useHub((s) => s.data.sessions.find((x) => x.id === session.id)?.messages.length ?? 0);
  const compacting = useHub((s) => !!s.compacting[session.id]);
  const [images, setImages] = useState<string[]>([]);
  // Im Arbeitsspeicher gehaltene Anhänge (Screenshots aus der Zwischenablage etc.) – werden nirgends gespeichert.
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [skills, setSkills] = useState<{ name: string; source: string }[]>([]);
  const [sel, setSel] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const pStatus = useHub((s) => s.statuses[session.provider]);
  const patch = useHub((s) => s.patchSession);
  const mode = chatMode(session.options);
  const imageReady = mode !== 'image' || !!session.options.imageGen;

  // Fehlt ein Modell, das Standardmodell eintragen, damit Anzeige und Aufruf übereinstimmen.
  useEffect(() => {
    if (mode === 'image' || !pStatus || (session.options.model && isChatModel(session.options.model))) return;
    const m = defaultModel(session.provider, pStatus);
    if (m) patch(session.id, { options: { ...session.options, model: m } });
  }, [session.id, session.provider, session.options, pStatus, patch]);

  const pick = (provider: ChatSession['provider'], model: string, imageGen?: string) => {
    const currentStatuses = useHub.getState().statuses;
    const base = provider === session.provider ? session.options : { ...useHub.getState().data.settings.providerDefaults[provider], chatMode: mode };
    model = canonicalModel(provider, model)!;
    const info = modelChoices(provider, currentStatuses).find((m) => m.id === model);
    patch(session.id, { provider, options: selectModelOptions(base, model, info, imageGen) });
  };

  const changeMode = (next: ChatMode) => {
    if (running) return;
    const currentStatuses = useHub.getState().statuses;
    patch(session.id, switchChatMode(session, next, imageEngines(currentStatuses)));
  };

  useEffect(() => { void hub.slash(session.cwd || '/nonexistent').then(setSkills); }, [session.cwd]);
  useEffect(() => { ta.current?.focus(); }, [session.id]);
  useEffect(() => {
    const h = (e: Event) => { setText((t0) => t0 + (t0 && !t0.endsWith(' ') ? ' ' : '') + (e as CustomEvent<string>).detail); ta.current?.focus(); };
    window.addEventListener('hub:insert', h);
    return () => window.removeEventListener('hub:insert', h);
  }, []);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.style.height = 'auto';
      const targetHeight = Math.min(el.scrollHeight, 220);
      el.style.height = `${targetHeight}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [text]);

  // Trigger-Erkennung: "/cmd" am Anfang oder "@pfad" am Wortende.
  const slashQ = /^\/(\S*)$/.exec(text)?.[1];
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1];

  useEffect(() => {
    if (mention === undefined || !session.cwd) return;
    let alive = true;
    const timer = setTimeout(() => {
      void hub.files(session.cwd, mention).then((f) => { if (alive) { setFiles(f); setSel(0); } });
    }, 100);
    return () => { alive = false; clearTimeout(timer); };
  }, [mention, session.cwd]);

  const slashItems = useMemo(() => {
    if (slashQ === undefined) return [];
    const q = slashQ.toLowerCase();
    const b = BUILTIN.map((x) => ({ kind: 'builtin' as const, name: x.name, desc: t(x.desc) }));
    const sk = session.provider === 'claude' ? skills.map((x) => ({ kind: 'skill' as const, name: x.name, desc: x.source })) : [];
    return [...b, ...sk].filter((x) => x.name.toLowerCase().includes(q)).slice(0, 10);
  }, [slashQ, skills, session.provider]);

  const items: { label: string; desc?: string; apply: () => void }[] =
    slashQ !== undefined
      ? slashItems.map((x) => ({ label: '/' + x.name, desc: x.desc, apply: () => setText(x.kind === 'builtin' ? `/${x.name} ` : `/${x.name} `) }))
      : mention !== undefined
        ? files.map((f) => ({ label: f, apply: () => setText((t) => t.replace(/@([^\s@]*)$/, `@${f} `)) }))
        : [];

  // Bilder aus der Zwischenablage (Screenshots etc.) einfügen
  // Eingefügte/abgelegte Dateien werden direkt gelesen und nur im Arbeitsspeicher gehalten (kein Speichern in einen Ordner):
  //  · Bilder -> Anhang (Base64) · Textdateien -> Inhalt direkt ins Eingabefeld · sonst: echter Dateipfad als @Pfad, falls vorhanden.
  const ingest = async (files: File[]): Promise<boolean> => {
    let used = false;
    for (const f of files) {
      let path = '';
      try { path = hub.pathForFile(f); } catch { /* Daten aus der Zwischenablage haben keinen Pfad */ }
      if (f.type.startsWith('image/')) {
        if (path) setImages((i) => [...i, path]);
        else {
          // erst lesen (await), dann den Zustand setzen – im setState-Callback darf kein await stehen
          const data = arrayToB64(new Uint8Array(await f.arrayBuffer()));
          setAtts((a) => [...a, { id: uid(), name: f.name && f.name !== 'image.png' ? f.name : `Bild ${a.length + 1}.${f.type.split('/')[1] || 'png'}`, mime: f.type, data }]);
        }
        used = true;
      } else if (f.size <= 200_000 && (f.type.startsWith('text/') || /\.(txt|md|json|ya?ml|toml|csv|log|xml|html?|css|[cm]?[jt]sx?|py|rs|go|java|kt|cs|cpp?|h|sh|sql|ini|env)$/i.test(f.name))) {
        const body = await f.text();
        setText((t0) => `${t0}${t0 && !t0.endsWith('\n') ? '\n\n' : ''}Datei ${f.name}:\n\`\`\`\n${body}\n\`\`\`\n`);
        used = true;
      } else if (path) {
        setText((t0) => t0 + (t0 && !t0.endsWith(' ') ? ' ' : '') + `@${path} `);
        used = true;
      }
    }
    return used;
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    await ingest(files);
  };

  const canDirect = DIRECT_MESSAGES[session.provider] && session.options.liveInput !== false && (mode === 'coding' || mode === 'text');
  const queued = useHub((s) => s.queued[session.id]) ?? [];

  const submit = (forceQueue = false) => {
    const t = text.trim();
    if ((!t && !images.length && !atts.length) || !imageReady) return;
    if (!running && t.startsWith('/')) {
      const [cmd, ...rest] = t.slice(1).split(/\s+/);
      if (BUILTIN.some((b) => b.name === cmd)) {
        if (onCommand(cmd, rest.join(' '))) { setText(''); return; }
      }
    }
    onSend(t, images, canDirect && !forceQueue ? 'direct' : 'queue', atts);
    setText('');
    setImages([]);
    setAtts([]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + items.length) % items.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && (mention !== undefined || (slashQ !== undefined && !BUILTIN.some((b) => b.name === slashQ))))) { e.preventDefault(); items[sel]?.apply(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(e.altKey); }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    void ingest([...e.dataTransfer.files]);
  };

  const meta = PROVIDERS[session.provider];

  return (
    <div className="mx-auto w-full max-w-5xl xl:max-w-6xl px-4 pb-4" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="relative rounded-[18px] border border-edge-strong bg-surface shadow-lg transition-colors focus-within:border-accent/60">
        {items.length > 0 && (
          <div data-state="open" className="pop absolute bottom-full left-0 right-0 z-30 mb-2 max-h-64 overflow-auto rounded-lumen border border-edge-strong bg-overlay p-1 shadow-2xl">
            {items.map((it, i) => (
              <button key={it.label} className={cx('flex w-full items-baseline gap-3 rounded-lumen-sm px-2.5 py-1.5 text-left', i === sel && 'bg-active')} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); it.apply(); ta.current?.focus(); }}>
                <span className="font-mono text-[12.5px]">{it.label}</span>
                {it.desc && <span className="truncate text-[11.5px] text-subtle">{it.desc}</span>}
              </button>
            ))}
          </div>
        )}
        {queued.length > 0 && (
          <div className="space-y-1 border-b border-edge px-3 py-2">
            <div className="text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('In der Warteschlange')}</div>
            {queued.map((q) => (
              <div key={q.id} className="chip-in flex items-center gap-2 rounded-lumen-sm bg-active px-2.5 py-1">
                <Icon name="lucide:clock" size={12} className="shrink-0 text-subtle" /><span className="min-w-0 flex-1 truncate text-[12.5px]">{q.text}</span>
                <button className="icon-btn !size-5" title={t('Entfernen')} onClick={() => useHub.getState().unqueue(session.id, q.id)}><Icon name="lucide:x" size={12} /></button>
              </div>
            ))}
          </div>
        )}
        {(images.length > 0 || atts.length > 0) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {atts.map((a) => (
              <span key={a.id} className="chip-in inline-flex items-center gap-1.5 rounded-md bg-active p-1 pr-2 text-[11.5px]"><img src={`data:${a.mime};base64,${a.data}`} alt="" className="size-8 rounded object-cover" />{a.name}
                <button onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))}><Icon name="lucide:x" size={12} /></button></span>
            ))}
            {images.map((p) => (
              <span key={p} className="chip-in inline-flex items-center gap-1.5 rounded-md bg-active p-1 pr-2 text-[11.5px]"><img src={'file://' + p} alt="" className="size-8 rounded object-cover" />{p.split(/[\\/]/).pop()}
                <button onClick={() => setImages((i) => i.filter((x) => x !== p))}><Icon name="lucide:x" size={12} /></button></span>
            ))}
          </div>
        )}
        {!imageReady && <div className="px-4 pt-3 text-[12px] text-warn">{t('Wähle ein Bildmodell. Verbinde bei Bedarf einen Anbieter in den Einstellungen.')}</div>}
        <textarea ref={ta} rows={1} value={text} onChange={(e) => { setText(e.target.value); setSel(0); }} onKeyDown={onKey} onPaste={onPaste}
          placeholder={mode === 'model' ? t('Beschreibe das 3D-Modell, Texturen, Materialien oder Animationen …') : mode === 'image' ? (getLang() === 'en' ? 'Describe the image … (or a change to the last one)' : 'Beschreibe das Bild … (oder eine Änderung am letzten)') : getLang() === 'en' ? `Message ${meta.name} …   (/ for commands, @ for files)` : `Nachricht an ${meta.name} …   (/ für Befehle, @ für Dateien)`}
          className="block max-h-[220px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed outline-none placeholder:text-subtle" />
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          <button className="icon-btn" title={t('Bild anhängen')} onClick={async () => { const f = await hub.pickFiles('image'); if (f.length) setImages((i) => [...i, ...f]); }}><Icon name="lucide:paperclip" /></button>
          <ChatModeButton value={mode} onChange={changeMode} disabled={running} />
          <ModelButton kind={mode === 'image' ? 'image' : 'text'} provider={session.provider} model={session.options.model} imageGen={session.options.imageGen} includeImages onPick={pick} />
          {mode === 'coding' && <ModeButton provider={session.provider} options={session.options} onChange={(p) => patch(session.id, { options: { ...session.options, ...p } })} onMore={() => useHub.getState().toggleChatOptions(true)} />}
          {mode !== 'image' && <TuneButton provider={session.provider} options={session.options} onChange={(p) => patch(session.id, { options: { ...session.options, ...p } })} />}
          <div className="flex-1" />
          {(mode === 'text' || mode === 'coding') && (
            <button className="btn btn-ghost !gap-1 !px-2 text-subtle disabled:opacity-35" disabled={running || compacting || msgCount < 4} onClick={() => onCommand('compact', '')} title={compacting ? t('Verlauf wird kompaktiert …') : t('Verlauf kompaktieren (/compact)')}>
              <Icon name={compacting ? 'lucide:loader-circle' : 'lucide:fold-vertical'} size={14} className={compacting ? 'spin' : ''} />
            </button>
          )}
          {mode !== 'image' && <FallbackButton session={session} />}
          <ComposerUsage session={session} />
          {/* Reihenfolge: Einreihen · Stopp · Senden – alle drei gleich hoch (h-8), Stopp in sanftem Rot direkt neben „Senden“ */}
          {running && canDirect && (
            <button className="btn !h-8 !rounded-full !px-3 text-[12px]" disabled={!imageReady || (!text.trim() && !images.length && !atts.length)} onClick={() => submit(true)} title={t('Einreihen (Alt+Enter): wird nach dem aktuellen Lauf gesendet')}><Icon name="lucide:list-plus" size={14} /> {t('Einreihen')}</button>
          )}
          {running && (
            <button className="chip-in grid h-8 w-11 place-items-center rounded-full border border-bad/30 bg-bad/15 text-bad transition-all hover:bg-bad/25 active:scale-95" onClick={onStop} title={t('Stopp')}><Icon name="lucide:square" size={13} /></button>
          )}
          <button className="grid h-8 w-11 place-items-center rounded-full bg-accent text-accent-fg transition-all enabled:hover:brightness-110 enabled:active:scale-95 disabled:opacity-35" disabled={!imageReady || (!text.trim() && !images.length && !atts.length)} onClick={() => submit()}
            title={running ? (canDirect ? t('Direkt senden (Enter) – mitten im Lauf') : t('Einreihen (Enter) – wird nach dem aktuellen Lauf gesendet')) : t('Senden (Enter)')}>
            <Icon name={running && !canDirect ? 'lucide:list-plus' : 'lucide:arrow-up'} size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Der Chat-Verlauf ändert sich beim Streamen ständig – das Eingabefeld rendert nur neu, wenn sich seine eigenen Eingaben ändern. */
export const Composer = memo(function Composer(props: Props) { return <ComposerInner key={props.session.id} {...props} />; });
