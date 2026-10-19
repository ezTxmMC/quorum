export interface ApiConnection {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  models: string[];
}

export interface OllamaModel {
  name: string;
  size: number;
  loaded: boolean;
  vram?: number;
}
export interface OllamaManagement {
  models: OllamaModel[];
  owned: boolean;
  host: string;
}
export interface OllamaPull {
  id: string;
  model: string;
  status: 'running' | 'done' | 'cancelled' | 'error';
  detail: string;
  completed?: number;
  total?: number;
}

export function apiBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Ungültige API-Basis-URL. HTTP/HTTPS ohne Zugangsdaten, Query oder Fragment verwenden.');
  return url.toString().replace(/\/+$/, '');
}
export const apiModelId = (connection: string, model: string) => `${connection}::${model}`;
export function resolveApiModel(id: string, connections: ApiConnection[]) {
  const connection = connections.find((c) => c.enabled && id.startsWith(`${c.id}::`));
  if (!connection) throw new Error('API-Verbindung nicht verfügbar. Bitte ein Modell aus der API-Gruppe wählen.');
  const model = id.slice(connection.id.length + 2);
  if (!model) throw new Error('Kein API-Modell ausgewählt.');
  return { connection, model };
}
