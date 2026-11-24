import type { Block, Message, ProviderId } from './types';

type ToolBlock = Extract<Block, { kind: 'tool' }>;

export type ContextLang = 'de' | 'en';

const CHARS_PER_TOKEN = 4;
const MESSAGE_CAP = 4000;
const MESSAGE_HEAD = 2600;
const MESSAGE_TAIL = 1200;
const GOAL_CAP = 1500;
const COMMAND_CAP = 160;
const MAX_FILES = 40;
const MAX_COMMANDS = 12;
const EDIT_TOOL = /edit|write|replace|file_change|apply_patch|notebook|create_file/i;
const COMMAND_TOOL = /bash|shell|command|terminal|exec/i;
const PATH_KEYS = ['file_path', 'path', 'AbsolutePath', 'TargetFile', 'notebook_path', 'filename'];
const COMMAND_KEYS = ['command', 'cmd', 'CommandLine'];
const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;

/** Fakten aus den Werkzeugaufrufen – exakt statt aus dem Gedächtnis eines Modells. */
export interface WorkDigest {
  files: string[];
  commands: string[];
}

export interface CompactionPlan {
  /** Wird durch die Zusammenfassung ersetzt. */
  head: Message[];
  /** Bleibt wörtlich erhalten. */
  tail: Message[];
}

export interface HandoffInfo {
  from: ProviderId;
  /** Anzahl übergebener Nachrichten. */
  messages: number;
  /** Geschätzte Token des übergebenen Kontexts. */
  tokens: number;
}

export interface Handoff extends HandoffInfo {
  text: string;
}

function messageText(message: Message): string {
  return message.blocks.map((block) => (block.kind === 'text' ? block.text : '')).filter(Boolean).join('\n').trim();
}

function toolsOf(message: Message): ToolBlock[] {
  return message.blocks.filter((block): block is ToolBlock => block.kind === 'tool');
}

function inputValue(tool: ToolBlock, keys: string[]): string | undefined {
  if (!tool.input || typeof tool.input !== 'object') {
    return undefined;
  }
  const values = tool.input as Record<string, unknown>;
  for (const key of keys) {
    const value = values[key];
    if (typeof value === 'string' && value) {
      return value;
    }
    if (Array.isArray(value) && value.length) {
      return value.join(' ');
    }
  }
  return undefined;
}

function editedFiles(tool: ToolBlock): string[] {
  if (!EDIT_TOOL.test(tool.name)) {
    return [];
  }
  const direct = inputValue(tool, PATH_KEYS);
  if (direct) {
    return [direct];
  }
  const patch = typeof tool.input === 'string' ? tool.input : inputValue(tool, ['patch', 'input', 'changes']) ?? '';
  return [...patch.matchAll(PATCH_FILE)].map((match) => match[1].trim());
}

function commandOf(tool: ToolBlock): string | undefined {
  if (!COMMAND_TOOL.test(tool.name)) {
    return undefined;
  }
  const command = inputValue(tool, COMMAND_KEYS)?.replace(/\s+/g, ' ').trim();
  return command ? clip(command, COMMAND_CAP) : undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function clipMiddle(text: string): string {
  if (text.length <= MESSAGE_CAP) {
    return text;
  }
  return `${text.slice(0, MESSAGE_HEAD)}\n[…]\n${text.slice(-MESSAGE_TAIL)}`;
}

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === 'text' || block.kind === 'thinking' || block.kind === 'inject') {
        chars += block.text.length;
      }
      if (block.kind === 'tool') {
        chars += (block.output?.length ?? 0) + JSON.stringify(block.input ?? '').length;
      }
    }
  }
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Geänderte Dateien (jede einmal, in Reihenfolge der ersten Änderung) und die zuletzt ausgeführten Befehle. */
export function workDigest(messages: Message[]): WorkDigest {
  const files = new Set<string>();
  const commands: string[] = [];
  for (const tool of messages.flatMap(toolsOf)) {
    for (const file of editedFiles(tool)) {
      files.add(file);
    }
    const command = commandOf(tool);
    if (command && commands.at(-1) !== command) {
      commands.push(command);
    }
  }
  return { files: [...files].slice(-MAX_FILES), commands: commands.slice(-MAX_COMMANDS) };
}

function toolNote(message: Message, lang: ContextLang): string {
  const tools = toolsOf(message);
  if (!tools.length) {
    return '';
  }
  const digest = workDigest([message]);
  const parts = [`${tools.length} ${lang === 'en' ? 'tool calls' : 'Werkzeugaufrufe'}`];
  if (digest.files.length) {
    parts.push(`${lang === 'en' ? 'edited' : 'geändert'}: ${digest.files.slice(-6).join(', ')}`);
  }
  if (digest.commands.length) {
    parts.push(`${lang === 'en' ? 'ran' : 'ausgeführt'}: ${digest.commands.slice(-3).map((command) => `\`${command}\``).join(', ')}`);
  }
  return ` [${parts.join(' · ')}]`;
}

function speaker(message: Message, lang: ContextLang): string {
  if (message.role === 'user') {
    return lang === 'en' ? 'User' : 'Nutzer';
  }
  if (message.role === 'system') {
    return lang === 'en' ? 'Summary of the earlier conversation' : 'Zusammenfassung des früheren Verlaufs';
  }
  const name = lang === 'en' ? 'Assistant' : 'Assistent';
  return message.provider ? `${name} (${message.provider}${message.model ? ` · ${message.model}` : ''})` : name;
}

function line(message: Message, lang: ContextLang, cap = clipMiddle): string {
  const text = messageText(message);
  const note = toolNote(message, lang);
  return text || note ? `${speaker(message, lang)}: ${cap(text)}${note}` : '';
}

/**
 * Verlauf als Text mit Zeichenbudget. Die neuesten Nachrichten haben Vorrang; frühere Zusammenfassungen und die erste
 * Nutzernachricht (das ursprüngliche Ziel) bleiben immer erhalten, weil ohne sie der Auftrag verloren ginge.
 */
export function transcript(messages: Message[], lang: ContextLang, budget: number): { text: string; included: number; omitted: number } {
  const firstUser = messages.findIndex((message) => message.role === 'user');
  const pinned = new Set(messages.map((message, index) => (message.role === 'system' || index === firstUser ? index : -1)).filter((index) => index >= 0));
  const lines = new Map<number, string>();
  let remaining = budget;
  for (const index of pinned) {
    const text = line(messages[index], lang, (value) => (index === firstUser ? clip(value, GOAL_CAP) : value));
    lines.set(index, text);
    remaining -= text.length;
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    if (pinned.has(index)) {
      continue;
    }
    const text = line(messages[index], lang);
    if (!text) {
      continue;
    }
    if (remaining - text.length < 0 && lines.size > pinned.size) {
      break;
    }
    lines.set(index, text);
    remaining -= text.length;
  }
  const kept = [...lines.entries()].filter(([, text]) => text).sort(([a], [b]) => a - b);
  const total = messages.filter((message) => line(message, lang)).length;
  const omitted = total - kept.length;
  const gap = omitted > 0 ? [lang === 'en' ? `[… ${omitted} older messages omitted …]` : `[… ${omitted} ältere Nachrichten ausgelassen …]`] : [];
  const pinnedLines = kept.filter(([index]) => pinned.has(index) && index <= firstUser).map(([, text]) => text);
  const rest = kept.filter(([index]) => !(pinned.has(index) && index <= firstUser)).map(([, text]) => text);
  return { text: [...pinnedLines, ...gap, ...rest].join('\n\n'), included: kept.length, omitted };
}

/** Teilt den Verlauf: die jüngsten Nachrichten bleiben wörtlich (ab einer Nutzernachricht, damit kein Wortwechsel zerschnitten wird), der Rest wird zusammengefasst. */
export function planCompaction(messages: Message[], keepChars: number): CompactionPlan {
  let cut = messages.length;
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    used += messageText(messages[index]).length;
    if (used > keepChars && cut < messages.length) {
      break;
    }
    if (messages[index].role === 'user') {
      cut = index;
    }
  }
  const tail = messages.slice(cut).filter((message) => message.role !== 'system');
  return { head: messages.slice(0, cut), tail };
}

export function compactionPrompt(head: Message[], lang: ContextLang, budget: number, focus?: string): string {
  const en = lang === 'en';
  const intro = en
    ? 'You are compacting a conversation so it can continue in a fresh context without losing anything that matters. Write the summary in exactly these sections, as short bullet points, without a preface and without using tools:'
    : 'Du verdichtest eine Unterhaltung, damit sie in einem frischen Kontext ohne Verlust des Wichtigen weitergeht. Schreibe die Zusammenfassung in genau diesen Abschnitten, als kurze Stichpunkte, ohne Einleitung und ohne Werkzeuge zu nutzen:';
  const sections = en
    ? ['## Goal – what the user wants, in their words', '## Decisions – what was decided and why', '## State – what is done, what works, what is broken', '## Details – exact file paths, identifiers, commands, values and error messages worth keeping', '## Preferences – how the user wants things done, corrections they gave', '## Open – unfinished tasks and the next concrete step']
    : ['## Ziel – was der Nutzer will, in seinen Worten', '## Entscheidungen – was entschieden wurde und warum', '## Stand – was fertig ist, was funktioniert, was kaputt ist', '## Details – exakte Dateipfade, Bezeichner, Befehle, Werte und Fehlermeldungen, die gebraucht werden', '## Präferenzen – wie der Nutzer es haben will, seine Korrekturen', '## Offen – unerledigte Aufgaben und der nächste konkrete Schritt'];
  const rules = en
    ? 'Keep facts exact, never invent. Carry an earlier summary forward instead of dropping it. Omit small talk and abandoned ideas.'
    : 'Fakten exakt übernehmen, nichts erfinden. Eine frühere Zusammenfassung fortschreiben statt verwerfen. Smalltalk und verworfene Ideen weglassen.';
  const focusLine = focus?.trim() ? `${en ? 'Pay special attention to' : 'Achte besonders auf'}: ${focus.trim()}` : '';
  const header = en ? '--- CONVERSATION ---' : '--- UNTERHALTUNG ---';
  return [intro, sections.join('\n'), rules, focusLine, header, transcript(head, lang, budget).text].filter(Boolean).join('\n\n');
}

function digestBlock(digest: WorkDigest, lang: ContextLang): string {
  const en = lang === 'en';
  const parts: string[] = [];
  if (digest.files.length) {
    parts.push(`${en ? 'Files changed so far' : 'Bisher geänderte Dateien'}:\n${digest.files.map((file) => `- ${file}`).join('\n')}`);
  }
  if (digest.commands.length) {
    parts.push(`${en ? 'Recently run commands' : 'Zuletzt ausgeführte Befehle'}:\n${digest.commands.map((command) => `- \`${command}\``).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Zusammenfassung plus die exakten Fakten aus den Werkzeugaufrufen des ersetzten Teils. */
export function compactionSummary(summary: string, head: Message[], lang: ContextLang): string {
  const facts = digestBlock(workDigest(head), lang);
  return facts ? `${summary.trim()}\n\n---\n${facts}` : summary.trim();
}

/**
 * Übergabe an einen anderen Anbieter: wer bisher geantwortet hat, was am Projekt bereits verändert wurde, und der Verlauf
 * mit Budget. Der neue Anbieter soll nahtlos weitermachen statt von vorn zu beginnen.
 */
export function handoff(messages: Message[], target: ProviderId, lang: ContextLang, budget: number, cwd?: string): Handoff | undefined {
  const body = transcript(messages, lang, budget);
  if (!body.included) {
    return undefined;
  }
  const en = lang === 'en';
  const previous = [...messages].reverse().find((message) => message.role === 'assistant' && message.provider && message.provider !== target)?.provider;
  const from = previous ?? target;
  const intro = en
    ? `[Handoff – you are taking over this conversation${previous ? ` from another assistant (${previous})` : ''}. The context below is background, do not reply to it.]`
    : `[Übergabe – du übernimmst diese Unterhaltung${previous ? ` von einem anderen Assistenten (${previous})` : ''}. Der Kontext unten ist Hintergrund, antworte nicht darauf.]`;
  const folder = cwd ? `${en ? 'Project folder' : 'Projektordner'}: ${cwd}` : '';
  const facts = digestBlock(workDigest(messages), lang);
  const guide = en
    ? 'Continue seamlessly: keep the decisions already made, do not redo finished work, and check the current files on disk before changing them – they already contain the changes listed above.'
    : 'Mach nahtlos weiter: Halte dich an die getroffenen Entscheidungen, wiederhole keine erledigte Arbeit und prüfe vor Änderungen den aktuellen Stand der Dateien – sie enthalten die oben genannten Änderungen bereits.';
  const text = [intro, folder, facts, en ? '--- Conversation so far ---' : '--- Bisheriger Verlauf ---', body.text, en ? '--- End of context ---' : '--- Ende des Kontexts ---', guide, en ? "[The user's current message:]" : '[Aktuelle Nachricht des Nutzers:]'].filter(Boolean).join('\n\n');
  return { text: `${text}\n`, from, messages: body.included, tokens: Math.round(text.length / CHARS_PER_TOKEN) };
}
