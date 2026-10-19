import type { ChatSession } from '@shared/types';

/** Search visible conversation text; tool output and private reasoning stay out of results. */
export function searchChat(session: ChatSession, query: string): { snippet?: string } | null {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return {};
  const texts = session.messages.flatMap((message) => message.blocks.flatMap((block) =>
    block.kind === 'text' || block.kind === 'inject' ? [block.text.replace(/\s+/g, ' ').trim()] : []));
  const haystack = [session.title, session.cwd, ...texts].join('\n').toLocaleLowerCase();
  if (!terms.every((term) => haystack.includes(term))) return null;
  const text = texts.find((value) => terms.some((term) => value.toLocaleLowerCase().includes(term)));
  if (!text) return {};
  const lower = text.toLocaleLowerCase();
  const index = Math.min(...terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0));
  const start = Math.max(0, index - 35);
  const end = Math.min(text.length, start + 120);
  return { snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}` };
}
