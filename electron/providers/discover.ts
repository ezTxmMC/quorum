import { LOCAL_PROBES } from '../../shared/api-presets';

export interface FoundServer { name: string; baseUrl: string; models: string[]; needsKey: boolean }

/** Sucht laufende OpenAI-kompatible Server auf 127.0.0.1. Nur GET /models ohne Zugangsdaten, kurze Zeitlimits, keine Weiterleitungen. */
export async function discoverLocalServers(): Promise<FoundServer[]> {
  const found = await Promise.all(LOCAL_PROBES.map(async (p): Promise<FoundServer | null> => {
    const baseUrl = `http://127.0.0.1:${p.port}${p.path}`;
    try {
      const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1200), redirect: 'error' });
      if (res.status === 401 || res.status === 403) return { name: p.name, baseUrl, models: [], needsKey: true };
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      if (!Array.isArray(body.data)) return null;
      return { name: p.name, baseUrl, models: body.data.map((m) => String(m.id ?? '')).filter(Boolean).slice(0, 200), needsKey: false };
    } catch { return null; }
  }));
  return found.filter((x): x is FoundServer => !!x);
}
