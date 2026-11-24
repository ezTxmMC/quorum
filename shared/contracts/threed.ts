import type { ProviderId, ProviderOptions } from '../types';

export interface ProjectInfo {
  id: string;
  name: string;
  updatedAt: number;
}

export interface WorkfileItem {
  id: string;
  name: string;
  path: string;
  type: 'bbmodel' | 'blend' | 'texture' | 'animation' | 'export';
  format?: string;
  size: number;
  updatedAt: number;
}

export type LoopEvent =
  | { type: 'iteration'; n: number }
  | { type: 'plan'; n: number; actions: number; errors: string[] }
  | { type: 'render'; n: number; ok: boolean; png?: string; error?: string }
  | { type: 'done'; ok: boolean; iterations: number; reason: string };

export type ChatEngine = { type: 'local'; modelId: string }
  | { type: 'cli'; provider: 'claude' | 'codex' | 'antigravity' | 'kimi' | 'opencode' }
  | { type: 'provider'; provider: ProviderId; options: ProviderOptions };
