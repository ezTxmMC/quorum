import type { ModelInfo } from './types';

interface KimiModelEntry {
  displayName?: unknown;
  provider?: unknown;
}

/** Ältere Quorum-Chats speichern noch die IDs der früheren Kimi-CLI („kimi-k3.1-pro“); die neue CLI erwartet Aliase wie „kimi-code/k3.1-pro“. */
export function kimiAlias(id: string): string {
  const legacy = /^kimi-(k3.*)$/.exec(id);
  return legacy ? `kimi-code/${legacy[1]}` : id;
}

/**
 * Liest die Modell-Aliase aus `kimi provider list --json`. Die Ausgabe enthält auch Zugangsdaten der Anbieter –
 * deshalb wird ausschließlich der Abschnitt `models` ausgewertet.
 * Effort-Stufen bleiben leer: die CLI nimmt sie nur aus ihrer config.toml, nicht pro Aufruf.
 */
export function parseKimiModels(json: string): ModelInfo[] {
  let models: Record<string, KimiModelEntry>;
  try {
    models = (JSON.parse(json) as { models?: Record<string, KimiModelEntry> }).models ?? {};
  } catch {
    return [];
  }
  const providers = new Set(Object.values(models).map((entry) => String(entry.provider ?? '')));
  return Object.entries(models).map(([alias, entry]) => {
    const name = typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : alias;
    const label = /^k\d/i.test(name) ? `Kimi ${name}` : name;
    // Nur bei mehreren eingerichteten Anbietern nach Anbieter gruppieren – sonst wäre die Überschrift bloß Rauschen.
    const group = providers.size > 1 ? String(entry.provider ?? '').replace(/^managed:/, '') : undefined;
    return { id: alias, label, efforts: [], group };
  });
}
