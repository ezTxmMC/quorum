// Capability-Routing für Agenten: wählt aus der Registry ein installiertes, lauffähiges Modell für eine Fähigkeit.
import type { Capability } from '../../shared/models';
import { routeModels } from '../../shared/route';
import { resolveRuntime, scheduler } from '../runtimes/scheduler';
import { listModels } from './registry';

/**
 * Modell-ID für eine Fähigkeit. Bevorzugt geladene Modelle (kein Ladevorgang nötig), sonst das neueste lauffähige.
 * Modelle, die eine Freigabe brauchen (eigener Code), werden übersprungen.
 */
export function modelForCapability(cap: Capability): string | undefined {
  const records = listModels();
  const loaded = new Set(scheduler.list().map((l) => l.modelId));
  const runnable = records.filter((m) => {
    try { resolveRuntime({ ...m, load: { ...m.load, trustRemoteCode: false } }); return true; } catch { return false; }
  });
  const candidates = runnable.map((m) => ({
    modelId: m.id,
    capabilities: m.capabilities,
    priority: (loaded.has(m.id) ? 1_000_000_000_000 : 0) + m.addedAt,
  }));
  return routeModels(candidates, { capability: cap })[0];
}
