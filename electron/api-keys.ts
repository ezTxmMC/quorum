import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './store';

const session = new Map<string, string>();
let saved: Promise<Record<string, string>> | undefined;
let pending = Promise.resolve();
function stored(): Promise<Record<string, string>> {
  if (saved) return saved;
  const file = join(dataDir(), 'api-keys.json');
  const p: Promise<Record<string, string>> = fs.readFile(file, 'utf8').then(async (text) => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // Beschädigte Datei: sichern statt still überschreiben.
      await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  }, (e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') return {};
    throw e;
  });
  saved = p;
  // Lesefehler nicht zwischenspeichern, damit der nächste Zugriff es erneut versucht.
  p.catch(() => { if (saved === p) saved = undefined; });
  return p;
}
function canEncrypt() { return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'); }
export async function apiKey(id: string): Promise<string | undefined> {
  if (session.has(id)) return session.get(id);
  let value: string | undefined;
  try { value = (await stored())[id]; } catch { return undefined; }
  if (!value || !canEncrypt()) return undefined;
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return undefined; }
}
export function setApiKey(id: string, value: string): Promise<{ persistent: boolean }> {
  if (!/^[\w-]{1,100}$/.test(id)) return Promise.reject(new Error('Ungültige Verbindungs-ID'));
  const persistent = canEncrypt();
  const result = pending.then(async () => {
    const values = await stored();
    const next = { ...values };
    if (value && persistent) next[id] = safeStorage.encryptString(value).toString('base64'); else delete next[id];
    const file = join(dataDir(), 'api-keys.json');
    // Erst schreiben, dann Speicherstand umstellen: ein Schreibfehler lässt Speicher und Platte konsistent.
    await fs.writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
    saved = Promise.resolve(next);
    if (value) session.set(id, value); else session.delete(id);
    return { persistent };
  });
  pending = result.then(() => {}, () => {});
  return result;
}
