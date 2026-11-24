import type { Message } from './types';

/** Scroll invalidation only: never serialize potentially megabyte-sized tool inputs. */
export function messageRenderRevision(message: Message): string {
  const block = message.blocks.at(-1);
  if (!block) { return `${message.id}:0`; }
  const size = block.kind === 'tool' ? (block.output?.length ?? 0) + Number(block.running)
    : 'text' in block ? block.text.length : 1;
  return `${message.id}:${message.blocks.length}:${size}:${message.error?.length ?? 0}`;
}
