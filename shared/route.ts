// Capability-basiertes Routing: welches installierte Modell bearbeitet eine Anfrage?
// Reine Funktion – Reihenfolge: manueller Override → Priorität → Fallbacks bei Fehler oder Speicherknappheit.
import type { Capability } from './models';

export interface RouteCandidate {
  modelId: string;
  capabilities: Capability[];
  /** Höher = bevorzugt. */
  priority: number;
  /** Fallback-Modelle: werden probiert, wenn dieses Modell nicht lauffähig ist. */
  fallbacks?: string[];
}

export interface RouteRequest {
  capability: Capability;
  /** Manuell gewähltes Modell – wird bevorzugt, wenn es die Capability hat. */
  override?: string;
  /** Modelle, die gerade nicht nutzbar sind (z. B. Fehler, zu wenig Speicher). */
  unavailable?: string[];
}

/** Geordnete Liste der Modelle, die für die Anfrage in Frage kommen. Leere Liste = kein passendes Modell. */
export function routeModels(candidates: RouteCandidate[], req: RouteRequest): string[] {
  const blocked = new Set(req.unavailable ?? []);
  const capable = candidates.filter((c) => c.capabilities.includes(req.capability) && !blocked.has(c.modelId));
  const byPriority = [...capable].sort((a, b) => b.priority - a.priority).map((c) => c.modelId);
  const order: string[] = [];
  if (req.override && capable.some((c) => c.modelId === req.override)) order.push(req.override);
  // Fallbacks des jeweils bevorzugten Modells direkt hinter diesem einreihen, sofern sie die Capability haben.
  const byId = new Map(capable.map((c) => [c.modelId, c]));
  for (const id of byPriority) {
    if (!order.includes(id)) order.push(id);
    for (const fb of byId.get(id)?.fallbacks ?? []) if (byId.has(fb) && !order.includes(fb)) order.push(fb);
  }
  return order;
}
