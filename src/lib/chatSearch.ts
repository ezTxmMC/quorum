import type { ChatSession, Message } from '@shared/types';

type Result = { snippet?: string } | null;
interface Pieces { texts: string[]; lower: string[] }

// Caches: Sessions/Messages sind unveränderlich (neues Objekt bei Änderung) – beim Streaming wird so nur die letzte Nachricht neu normalisiert.
const pieceCache = new WeakMap<Message, Pieces>();
const resultCache = new WeakMap<ChatSession, Map<string, Result>>();

function piecesOf(message: Message): Pieces {
  let p = pieceCache.get(message);
  if (!p) {
    const texts = message.blocks.flatMap((block) => block.kind === 'text' || block.kind === 'inject' ? [block.text.replace(/\s+/g, ' ').trim()] : []);
    p = { texts, lower: texts.map((x) => x.toLocaleLowerCase()) };
    pieceCache.set(message, p);
  }
  return p;
}

/** Search visible conversation text; tool output and private reasoning stay out of results. */
export function searchChat(session: ChatSession, query: string): Result {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return {};
  const key = terms.join(' ');
  let perQuery = resultCache.get(session);
  if (!perQuery) { perQuery = new Map(); resultCache.set(session, perQuery); }
  if (perQuery.has(key)) return perQuery.get(key) as Result;
  const result = compute(session, terms);
  perQuery.set(key, result);
  return result;
}

function compute(session: ChatSession, terms: string[]): Result {
  const head = [session.title, session.cwd].map((x) => (x ?? '').toLocaleLowerCase());
  const pieces = session.messages.map(piecesOf);
  const has = (term: string) => head.some((h) => h.includes(term)) || pieces.some((p) => p.lower.some((l) => l.includes(term)));
  if (!terms.every(has)) return null;
  for (const p of pieces) {
    const at = p.lower.findIndex((l) => terms.some((term) => l.includes(term)));
    if (at < 0) continue;
    const text = p.texts[at];
    const lower = p.lower[at];
    const index = Math.min(...terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0));
    const start = Math.max(0, index - 35);
    const end = Math.min(text.length, start + 120);
    return { snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}` };
  }
  return {};
}
