import type { ProviderId, Settings } from './types';

/** Anbieter mit eigener CLI – nur sie lassen sich isoliert installieren. */
export const SANDBOX_PROVIDERS = ['claude', 'codex', 'antigravity', 'kimi', 'opencode'] as const satisfies readonly ProviderId[];

export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

export interface SandboxStatus {
  provider: SandboxProvider;
  /** false, wenn das System keine Sandbox bereitstellen kann (kein Linux oder kein bubblewrap). */
  supported: boolean;
  reason?: string;
  installed: boolean;
  bin?: string;
  version?: string;
  home: string;
}

export interface SandboxProgress {
  provider: SandboxProvider;
  text: string;
}

export interface SandboxResult {
  ok: boolean;
  error?: string;
}

export function isSandboxProvider(id: ProviderId): id is SandboxProvider {
  return (SANDBOX_PROVIDERS as readonly ProviderId[]).includes(id);
}

/** CLI-Pfade, wie sie tatsächlich gestartet werden: eine aktive Sandbox-Variante ersetzt den Pfad des Anbieters. */
export function effectiveBinaries(settings: Pick<Settings, 'binaries' | 'sandboxed'>): Partial<Record<ProviderId, string>> {
  const binaries = { ...settings.binaries };
  for (const [id, bin] of Object.entries(settings.sandboxed ?? {})) {
    if (bin) {
      binaries[id as ProviderId] = bin;
    }
  }
  return binaries;
}
