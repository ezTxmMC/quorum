import type { HubEvent, Message } from '@shared/types';

/** Wendet ein normalisiertes Event auf eine Assistant-Nachricht an (immutabel). */
export function applyEvent(m: Message, e: HubEvent): Message {
  switch (e.type) {
    case 'text':
    case 'thinking': {
      const kind = e.type === 'text' ? 'text' : 'thinking';
      const blocks = m.blocks.slice();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) blocks[blocks.length - 1] = { ...last, text: last.text + e.delta };
      else blocks.push({ kind, text: e.delta });
      return { ...m, blocks };
    }
    case 'text_full':
      return { ...m, blocks: [...m.blocks, { kind: 'text', text: e.text }] };
    case 'image':
      if (m.blocks.some((b) => b.kind === 'image' && b.path === e.path)) return m;
      return { ...m, blocks: [...m.blocks, { kind: 'image', path: e.path, engine: e.engine }] };
    case 'tool_start':
      if (m.blocks.some((b) => b.kind === 'tool' && b.id === e.id)) return { ...m, blocks: m.blocks.map((b) => b.kind === 'tool' && b.id === e.id ? { ...b, name: e.name, input: e.input ?? b.input, parentId: e.parentId ?? b.parentId } : b) };
      return { ...m, blocks: [...m.blocks, { kind: 'tool', id: e.id, name: e.name, input: e.input, running: true, parentId: e.parentId }] };
    case 'tool_end':
      return { ...m, blocks: m.blocks.map((b) => (b.kind === 'tool' && b.id === e.id ? { ...b, output: e.output, isError: e.isError, running: false } : b)) };
    case 'usage': {
      const { type: _t, ...u } = e;
      return { ...m, usage: { ...m.usage, ...u } };
    }
    case 'notice': {
      const line = (e.level === 'error' ? '' : '⚠ ') + e.text;
      return { ...m, error: m.error ? `${m.error}\n${line}` : line };
    }
    case 'done':
      return {
        ...m,
        blocks: m.blocks.map((b) => (b.kind === 'tool' && b.running ? { ...b, running: false } : b)),
        error: !e.ok && e.error && !m.error ? e.error : !e.ok && e.error && !m.error?.includes(e.error) ? `${m.error}\n${e.error}` : m.error,
      };
    default:
      return m;
  }
}

export function messageText(m: Message): string {
  return m.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
}
