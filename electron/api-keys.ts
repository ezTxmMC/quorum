import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './store';

const session = new Map<string, string>();
let saved: Promise<Record<string, string>> | undefined;
let pending = Promise.resolve();
function stored(): Promise<Record<string, string>> {
  return saved ??= fs.readFile(join(dataDir(), 'api-keys.json'), 'utf8').then((value) => JSON.parse(value) as Record<string, string>).catch(() => ({}));
}
function canEncrypt() { return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'); }
export async function apiKey(id: string): Promise<string | undefined> {
  if (session.has(id)) return session.get(id);
  const value = (await stored())[id];
  if (!value || !canEncrypt()) return undefined;
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return undefined; }
}
export function setApiKey(id: string, value: string): Promise<{ persistent: boolean }> {
  if (!/^[\w-]{1,100}$/.test(id)) return Promise.reject(new Error('Ungültige Verbindungs-ID'));
  const persistent = canEncrypt();
  const result = pending.then(async () => {
    const values = await stored();
    if (value) session.set(id, value); else session.delete(id);
    if (value && persistent) values[id] = safeStorage.encryptString(value).toString('base64'); else delete values[id];
    const file = join(dataDir(), 'api-keys.json');
    await fs.writeFile(file + '.tmp', JSON.stringify(values), { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
    return { persistent };
  });
  pending = result.then(() => {}, () => {});
  return result;
}
