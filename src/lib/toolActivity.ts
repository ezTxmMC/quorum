import type { Block } from '@shared/types';

export type ToolBlock = Extract<Block, { kind: 'tool' }>;
export type ActivityKind = 'command' | 'search' | 'edit' | 'read' | 'task';

export function toolKind(name: string): ActivityKind {
  if (/bash|shell|command|terminal|exec|write_stdin/i.test(name)) return 'command';
  if (/grep|glob|find|search|suche|web|fetch|url|browser/i.test(name)) return 'search';
  if (/edit|write|replace|file_change|apply_patch|notebook/i.test(name)) return 'edit';
  if (/read|view|cat|list_dir|^ls$/i.test(name)) return 'read';
  return 'task';
}

export function toolSummary(tool: ToolBlock): string {
  const input = tool.input;
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim();
  if (!input || typeof input !== 'object') return tool.name;
  const values = input as Record<string, unknown>;
  const keys = ['description', 'command', 'cmd', 'CommandLine', 'pattern', 'query', 'Query', 'file_path', 'path', 'AbsolutePath', 'TargetFile', 'url', 'prompt'];
  const key = keys.find((name) => typeof values[name] === 'string' && values[name]);
  return key ? String(values[key]).replace(/\s+/g, ' ').trim() : tool.name;
}

export function activeToolActivity(blocks: Block[]) {
  const active = blocks.filter((b): b is ToolBlock => b.kind === 'tool' && b.running);
  const latest = active.at(-1);
  return latest ? { count: active.length, kind: toolKind(latest.name), summary: toolSummary(latest) } : null;
}
