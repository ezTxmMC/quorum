// Quorum im Terminal: `quorum --tui [Ordner]` (interaktiv) und `quorum -p "…"` (Einmal-Antwort auf stdout).
// Läuft als reiner Node-Prozess ohne Fenster; nutzt dieselben Provider-Runner wie die App und liest deren Einstellungen (nur lesend).
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import pkg from '../package.json';
import { PROVIDERS, isTextOnly, modePatch, modesFor, type ModeId } from '../shared/catalog';
import type { ChatSession, HubEvent, Message, ProviderId, ProviderOptions, RunRequest } from '../shared/types';
import { HELP, parseArgs, type CliArgs } from './args';
import { load } from '../electron/store';
import { writeInbox } from '../electron/inbox';
import { providerStatus } from '../electron/providers/detect';
import { cancelAll, cancelRun, runCli } from '../electron/providers/runner';
import { configureApi } from '../electron/providers/api';
import { setOllamaSettings } from '../electron/providers/ollama';

const color = !process.env.NO_COLOR && process.stderr.isTTY;
const c = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c(2, s);
const bold = (s: string) => c(1, s);
const accent = (s: string) => c(36, s);

const IDS = Object.keys(PROVIDERS) as ProviderId[];
const isProvider = (v: string | undefined): v is ProviderId => !!v && (IDS as string[]).includes(v);

const textOf = (m: Message) => m.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
const toHistory = (msgs: Message[]) => msgs.slice(-40).filter((m) => m.role !== 'system' && textOf(m)).map((m) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: textOf(m) }));
/** Wechselt der Anbieter mitten im Chat, bekommt der neue den bisherigen Verlauf als Kontext (wie in der App). */
function preamble(msgs: Message[]): string {
  const lines = msgs.slice(-12).filter((m) => m.role !== 'system' && textOf(m)).map((m) => { const t = textOf(m); return `${m.role === 'user' ? 'Nutzer' : `Assistent (${m.provider ?? '?'})`}: ${t.length > 1800 ? t.slice(0, 1800) + '…' : t}`; });
  return lines.length ? `[Bisheriger Gesprächsverlauf mit einem anderen Assistenten – nur als Kontext:]\n${lines.join('\n\n')}\n\n[Aktuelle Nachricht des Nutzers:]\n` : '';
}
const sessionsFor = (cwd: string): ChatSession[] => load().sessions.filter((x) => x.cwd === cwd).sort((a, b) => b.updatedAt - a.updatedAt);

function optionsFor(provider: ProviderId, args: Pick<CliArgs, 'model' | 'permission'>, defaults: ProviderOptions, unattended: boolean): ProviderOptions {
  let o: ProviderOptions = { ...defaults, chatMode: provider === 'ollama' || provider === 'local' || provider === 'api' ? 'text' : 'coding' };
  if (args.model) o.model = args.model;
  const mode = args.permission;
  if (mode && (modesFor(provider) as string[]).includes(mode)) o = { ...o, ...modePatch(provider, mode as ModeId) };
  else if (mode) o.permission = mode;
  // Ohne Rückfragemöglichkeit läuft -p standardmäßig im schreibgeschützten Plan-Modus.
  else if (unattended && (modesFor(provider) as string[]).includes('plan')) o = { ...o, ...modePatch(provider, 'plan') };
  return o;
}

interface Turn { ok: boolean; text: string; sessionId?: string }

async function runTurn(req: RunRequest, binaries: Partial<Record<ProviderId, string>>, onEvent: (e: HubEvent) => void): Promise<Turn> {
  let sessionId: string | undefined;
  let text = '';
  let ok = false;
  await runCli(req, (e) => {
    if (e.type === 'session') sessionId = e.sessionId;
    if (e.type === 'text') text += e.delta;
    if (e.type === 'text_full') text = e.text;
    if (e.type === 'done') ok = e.ok;
    onEvent(e);
  }, binaries);
  return { ok, text, sessionId };
}

function setup() {
  const data = load();
  configureApi(() => data.settings.apiConnections ?? [], async (id) => process.env[`QUORUM_API_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]);
  setOllamaSettings(() => data.settings.ollama ?? {});
  return data;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// ---- Einmal-Antwort (-p) ------------------------------------------------------------------------------------------------

async function printMode(a: CliArgs): Promise<number> {
  const data = setup();
  const provider = isProvider(a.provider) ? a.provider : data.settings.defaultProvider;
  let prompt = a.print === '-' ? '' : (a.print ?? '');
  if (a.rest.length) prompt = [prompt, a.rest.join(' ')].filter(Boolean).join(' ');
  // stdin nur bei `-p -` oder ohne Prompt lesen – sonst würde eine offene Pipe (cron, CI) ewig blockieren.
  const input = a.print === '-' || !prompt.trim() ? await readStdin() : '';
  if (input.trim()) prompt = prompt ? `${prompt}\n\n${input}` : input;
  if (!prompt.trim()) { process.stderr.write('quorum: empty prompt\n'); return 2; }
  const cwd = a.folder ?? process.cwd();
  const req: RunRequest = { runId: randomUUID(), provider, prompt, cwd, options: optionsFor(provider, a, data.settings.providerDefaults[provider] ?? {}, true) };
  const stop = () => { cancelAll(); process.exit(130); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const r = await runTurn(req, data.settings.binaries, (e) => {
    if (a.json) { process.stdout.write(JSON.stringify(e) + '\n'); return; }
    if (e.type === 'text') process.stdout.write(e.delta);
    else if (e.type === 'notice' && e.level !== 'info') process.stderr.write(`${e.text}\n`);
    else if (e.type === 'done' && !e.ok && e.error) process.stderr.write(`quorum: ${e.error}\n`);
  });
  if (!a.json) {
    // text_full liefert den Text ohne Deltas (z. B. Codex): dann am Ende ausgeben.
    if (!r.text.endsWith('\n')) process.stdout.write('\n');
  }
  return r.ok ? 0 : 1;
}

// ---- Interaktive Terminal-Oberfläche ---------------------------------------------------------------------------------

const HELP_TUI = `Commands:
  /provider <id>   switch provider (${IDS.join(', ')})
  /model [id]      show models or set the model
  /mode <mode>     permission mode (ask, edit, plan, auto, noask, full – as far as the provider supports)
  /new             start a fresh conversation
  /chats           list this folder's chats (shared with the app)
  /resume <n>      continue one of them
  /cwd             show the working folder
  /help            this list
  /quit            leave (Ctrl+D also works)
Ctrl+C cancels a running answer, a second Ctrl+C quits.`;

async function tui(a: CliArgs): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write('quorum --tui needs an interactive terminal (use -p for scripts)\n'); return 2; }
  const data = setup();
  let provider: ProviderId = isProvider(a.provider) ? a.provider : data.settings.defaultProvider;
  const cwd = a.folder ?? process.cwd();
  const settings = data.settings;
  let options = optionsFor(provider, a, settings.providerDefaults[provider] ?? {}, false);
  const blank = () => ({ id: randomUUID() as string, title: '', createdAt: Date.now(), providerSessions: {} as Partial<Record<ProviderId, string>>, messages: [] as Message[] });
  let chat = blank();
  const adopt = (x: ChatSession) => { chat = { id: x.id, title: x.title, createdAt: x.createdAt, providerSessions: { ...x.providerSessions }, messages: [...x.messages] }; };
  if (a.continueLast) { const last = sessionsFor(cwd)[0]; if (last) { adopt(last); if (!a.provider) provider = last.provider; } }
  let sessionId: string | undefined = chat.providerSessions[provider];
  let runId: string | null = null;
  let lastInterrupt = 0;

  const header = () => process.stdout.write(`${bold(accent('Quorum'))} ${dim(`v${pkg.version} · ${PROVIDERS[provider].name}${options.model ? ' · ' + options.model : ''} · ${cwd}`)}\n${dim('Type a message, /help for commands.')}\n`);
  header();
  if (chat.messages.length) process.stdout.write(dim(`Continuing "${chat.title || chat.id.slice(0, 8)}" (${chat.messages.length} messages)\n`));

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${accent('›')} `, historySize: 200 });
  let closed = false;
  const done = new Promise<void>((resolve) => rl.on('close', () => { closed = true; resolve(); }));
  process.on('SIGTERM', () => { cancelAll(); process.exit(143); });
  rl.on('SIGINT', () => {
    if (runId) { cancelRun(runId); process.stdout.write(dim('\n(cancelled)\n')); return; }
    if (Date.now() - lastInterrupt < 1500) { rl.close(); return; }
    lastInterrupt = Date.now();
    process.stdout.write(dim('\nPress Ctrl+C again to quit.\n')); rl.prompt();
  });

  const command = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case 'quit': case 'exit': case 'q': rl.close(); return true;
      case 'help': case '?': process.stdout.write(HELP_TUI + '\n'); return true;
      case 'chats': {
        const list = sessionsFor(cwd).slice(0, 10);
        process.stdout.write(list.length ? list.map((x, n) => `  ${n + 1}. ${x.title || x.id.slice(0, 8)}  ${dim(`${PROVIDERS[x.provider].name} · ${x.messages.length} msgs · ${new Date(x.updatedAt).toLocaleString()}`)}`).join('\n') + '\n' + dim('/resume <number> continues one.\n') : dim('No chats for this folder yet.\n'));
        return true;
      }
      case 'resume': {
        const list = sessionsFor(cwd);
        const x = list[Number(arg) - 1] ?? list.find((c) => c.id.startsWith(arg));
        if (!x) { process.stdout.write('Unknown chat. /chats lists them.\n'); return true; }
        adopt(x); provider = x.provider; options = optionsFor(provider, { model: undefined, permission: undefined }, { ...(settings.providerDefaults[provider] ?? {}), ...x.options }, false); sessionId = chat.providerSessions[provider];
        process.stdout.write(dim(`Resumed "${chat.title || chat.id.slice(0, 8)}" (${chat.messages.length} messages)\n`));
        return true;
      }
      case 'cwd': process.stdout.write(cwd + '\n'); return true;
      case 'new': chat = blank(); sessionId = undefined; process.stdout.write(dim('Fresh conversation.\n')); return true;
      case 'provider':
        if (!isProvider(arg)) { process.stdout.write(`Providers: ${IDS.join(', ')}\n`); return true; }
        provider = arg; options = optionsFor(provider, { model: undefined, permission: undefined }, settings.providerDefaults[provider] ?? {}, false); sessionId = chat.providerSessions[provider];
        process.stdout.write(dim(`Provider: ${PROVIDERS[provider].name}\n`)); return true;
      case 'model': {
        if (arg) { options = { ...options, model: arg }; process.stdout.write(dim(`Model: ${arg}\n`)); return true; }
        const st = await providerStatus(provider, settings.binaries);
        process.stdout.write(st.models.length ? st.models.map((m) => `  ${m.id}${m.label !== m.id ? dim('  ' + m.label) : ''}`).join('\n') + '\n' : dim(st.installed ? 'No models reported.\n' : `${PROVIDERS[provider].name} is not installed/available.\n`));
        return true;
      }
      case 'mode':
        if (!(modesFor(provider) as string[]).includes(arg)) { process.stdout.write(`Modes for ${provider}: ${modesFor(provider).join(', ')}\n`); return true; }
        options = { ...options, ...modePatch(provider, arg as ModeId) }; process.stdout.write(dim(`Mode: ${arg}\n`)); return true;
      default: process.stdout.write(`Unknown command /${cmd}. /help lists them.\n`); return true;
    }
  };

  rl.prompt();
  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) { rl.prompt(); return; }
    void (async () => {
      rl.pause();
      try {
        if (line.startsWith('/')) { await command(line); }
        else {
          runId = randomUUID();
          const prior = chat.messages;
          const prompt = !sessionId && prior.length && !isTextOnly(provider) ? preamble(prior) + line : line;
          const req: RunRequest = { runId, provider, prompt, cwd, options, resume: sessionId ? { sessionId } : undefined, history: isTextOnly(provider) ? toHistory(prior) : undefined };
          let started = false;
          const r = await runTurn(req, settings.binaries, (e) => {
            if (e.type === 'text') { if (!started) { started = true; } process.stdout.write(e.delta); }
            else if (e.type === 'tool_start') process.stdout.write(`\n${dim('⚙ ' + e.name + toolHint(e.input))}\n`);
            else if (e.type === 'notice' && e.level !== 'info') process.stdout.write(`\n${c(33, e.text)}\n`);
            else if (e.type === 'done' && !e.ok && e.error) process.stdout.write(`\n${c(31, e.error)}\n`);
          });
          runId = null;
          if (r.text && !started) process.stdout.write(r.text);
          process.stdout.write('\n');
          if (r.ok) {
            const now = Date.now();
            const turn: Message[] = [
              { id: randomUUID(), role: 'user', blocks: [{ kind: 'text', text: line }], createdAt: now },
              { id: randomUUID(), role: 'assistant', provider, model: options.model, blocks: [{ kind: 'text', text: r.text }], createdAt: now + 1 },
            ];
            chat.messages.push(...turn);
            if (!chat.title) chat.title = line.replace(/\s+/g, ' ').trim().slice(0, 56);
            if (r.sessionId) { sessionId = r.sessionId; chat.providerSessions[provider] = r.sessionId; }
            // Die App übernimmt den Turn aus dem Posteingang und zeigt den Chat in ihrer Liste.
            try { writeInbox({ v: 1, chat: { id: chat.id, title: chat.title, cwd, provider, options, providerSessions: chat.providerSessions, createdAt: chat.createdAt }, messages: turn }); } catch { /* Teilen ist Komfort */ }
          }
        }
      } catch (err) {
        runId = null;
        process.stdout.write(`${c(31, (err as Error).message)}\n`);
      }
      if (!closed) { rl.resume(); rl.prompt(); }
    })();
  });
  await done;
  cancelAll();
  return 0;
}

const toolHint = (input: unknown): string => {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url;
  return typeof v === 'string' ? ` ${v.length > 80 ? v.slice(0, 77) + '…' : v}` : '';
};

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, process.cwd());
  if (a.help) { process.stdout.write(HELP); return 0; }
  if (a.version) { process.stdout.write(`${pkg.version}\n`); return 0; }
  for (const w of a.unknown) process.stderr.write(`quorum: ignoring unknown option ${w}\n`);
  if (a.errors.length) { process.stderr.write(a.errors.map((e) => `quorum: ${e}`).join('\n') + '\n'); return 2; }
  if (a.print !== undefined) return printMode(a);
  if (a.tui) return tui(a);
  process.stderr.write('quorum: nothing to do in terminal mode (use --tui or -p). Run without those flags to open the app.\n');
  return 2;
}
