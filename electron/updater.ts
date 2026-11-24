import { app, shell } from 'electron';
import { createReadStream, promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { UpdateAsset, UpdateChannel, UpdateInfo, UpdateProgress, UpdateState } from '../shared/types';
import { dataDir } from './store';

const GITHUB_REPO = 'ezTxmMC/quorum';
const API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;

let state: UpdateState = {
  status: 'idle',
  currentVersion: app.getVersion() || '1.0.0',
  channel: 'release',
};

let eventEmitter: ((channel: string, payload: unknown) => void) | null = null;

export function setUpdaterEmitter(emitter: (channel: string, payload: unknown) => void) {
  eventEmitter = emitter;
}

function emitStatus() {
  if (eventEmitter) {
    eventEmitter('updater:status', { ...state });
  }
}

function emitProgress(p: UpdateProgress) {
  if (eventEmitter) {
    eventEmitter('updater:progress', p);
  }
}

export function parseTag(tag: string): { base: string; channel: UpdateChannel; id: string | number } | null {
  const clean = tag.trim().replace(/^v/, '');
  const mDev = /^(\d+\.\d+\.\d+)-dev\.([0-9a-fA-F]+)$/.exec(clean);
  if (mDev) return { base: mDev[1], channel: 'dev', id: mDev[2].toLowerCase() };
  const mBeta = /^(\d+\.\d+\.\d+)-beta\.(\d+)$/.exec(clean);
  if (mBeta) return { base: mBeta[1], channel: 'beta', id: parseInt(mBeta[2], 10) };
  const mRel = /^(\d+\.\d+\.\d+)-release\.(\d+)$/.exec(clean);
  if (mRel) return { base: mRel[1], channel: 'release', id: parseInt(mRel[2], 10) };
  const mSem = /^(\d+\.\d+\.\d+)/.exec(clean);
  if (mSem) return { base: mSem[1], channel: 'release', id: 0 };
  return null;
}

function isNewer(remoteTag: string, curVer: string, targetChannel: UpdateChannel): boolean {
  const remote = parseTag(remoteTag);
  const cur = parseTag(curVer);
  if (!remote) return false;
  // Wenn aktuelle Version nicht geparst werden kann (z.B. dev build "1.0.0"), ist ein Release verfügbar
  if (!cur) return true;

  // Gleicher Kanal: nur echte Fortschritte zählen (identischer Tag ist kein Update).
  if (remote.channel === cur.channel) return remote.channel === 'dev' ? String(remote.id) !== String(cur.id) : (remote.id as number) > (cur.id as number);

  // Wenn wir auf dev-Kanal sind
  if (targetChannel === 'dev') {
    if (remote.channel === 'dev' && cur.channel === 'dev') {
      return String(remote.id) !== String(cur.id);
    }
    return true;
  }

  // Wenn wir auf beta-Kanal sind
  if (targetChannel === 'beta') {
    if (remote.channel === 'release') return true;
    if (remote.channel === 'beta') {
      if (cur.channel !== 'beta') return true;
      return (remote.id as number) > (cur.id as number);
    }
    return false;
  }

  // Release-Kanal
  if (targetChannel === 'release') {
    if (remote.channel === 'release') {
      if (cur.channel !== 'release') return true;
      return (remote.id as number) > (cur.id as number);
    }
    return false;
  }

  return false;
}

interface RawAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
  digest?: string | null;
}

interface RawRelease {
  tag_name: string;
  name?: string;
  body?: string;
  prerelease: boolean;
  draft: boolean;
  published_at?: string;
  assets?: RawAsset[];
}

function pickAsset(assets: RawAsset[]): UpdateAsset | undefined {
  if (!assets || !assets.length) return undefined;
  const platform = process.platform;
  let match: RawAsset | undefined;

  if (platform === 'linux') {
    match = assets.find((a) => a.name.endsWith('.AppImage')) || assets.find((a) => a.name.endsWith('.deb'));
  } else if (platform === 'win32') {
    // Der Betriebssystem-Teil im Dateinamen trennt die Windows- von den macOS-Archiven.
    const own = assets.filter((a) => /-win-/i.test(a.name));
    match = own.find((a) => a.name.endsWith('.exe')) || own.find((a) => a.name.endsWith('.zip'));
  } else if (platform === 'darwin') {
    const own = assets.filter((a) => /-mac-/i.test(a.name));
    match = own.find((a) => a.name.endsWith('.dmg')) || own.find((a) => a.name.endsWith('.zip'));
  }

  if (match) {
    return {
      name: match.name,
      downloadUrl: match.browser_download_url,
      size: match.size,
      contentType: match.content_type,
      digest: match.digest ?? undefined,
    };
  }
  return undefined;
}

export async function checkUpdate(channel: UpdateChannel = 'release'): Promise<UpdateState> {
  state = {
    ...state,
    status: 'checking',
    channel,
    error: undefined,
  };
  emitStatus();

  try {
    const res = await fetch(API_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Quorum-Desktop-App',
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        state = {
          ...state,
          status: 'up-to-date',
          lastChecked: Date.now(),
        };
        emitStatus();
        return state;
      }
      throw new Error(`GitHub API Fehler (${res.status}): ${res.statusText}`);
    }

    const releases = (await res.json()) as RawRelease[];
    const validReleases = releases.filter((r) => !r.draft && r.tag_name);

    // Filtere nach gewähltem Kanal
    const matching = validReleases.filter((r) => {
      const p = parseTag(r.tag_name);
      if (!p) return false;
      if (channel === 'dev') return true; // Alles zulassen
      if (channel === 'beta') return p.channel === 'beta' || p.channel === 'release';
      if (channel === 'release') return p.channel === 'release' && !r.prerelease;
      return false;
    });

    if (!matching.length) {
      state = {
        ...state,
        status: 'up-to-date',
        lastChecked: Date.now(),
      };
      emitStatus();
      return state;
    }

    const latest = matching[0];
    const asset = pickAsset(latest.assets ?? []);
    const p = parseTag(latest.tag_name);
    const releaseChannel = p?.channel ?? 'release';

    const info: UpdateInfo = {
      version: latest.tag_name.replace(/^v/, ''),
      tag: latest.tag_name,
      channel: releaseChannel,
      name: latest.name || latest.tag_name,
      notes: latest.body || '',
      publishedAt: latest.published_at || new Date().toISOString(),
      asset,
    };

    const hasNewer = isNewer(latest.tag_name, state.currentVersion, channel);

    if (hasNewer) {
      state = {
        ...state,
        status: 'available',
        updateInfo: info,
        lastChecked: Date.now(),
      };
    } else {
      state = {
        ...state,
        status: 'up-to-date',
        updateInfo: info,
        lastChecked: Date.now(),
      };
    }

    emitStatus();
    return state;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    state = {
      ...state,
      status: 'error',
      error: errorMsg,
      lastChecked: Date.now(),
    };
    emitStatus();
    return state;
  }
}

/** Release, zu dem die heruntergeladene Datei gehört. */
let downloadedTag: string | undefined;

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

export async function downloadUpdate(): Promise<boolean> {
  const asset = state.updateInfo?.asset;
  if (!asset?.downloadUrl) {
    state = { ...state, status: 'error', error: 'Kein passendes Installationspaket gefunden.' };
    emitStatus();
    return false;
  }

  state = { ...state, status: 'downloading', error: undefined };
  emitStatus();

  try {
    const updatesDir = join(dataDir(), 'updates');
    await fsp.mkdir(updatesDir, { recursive: true });
    const targetFile = join(updatesDir, asset.name);

    const res = await fetch(asset.downloadUrl, {
      headers: {
        'User-Agent': 'Quorum-Desktop-App',
      },
    });

    if (!res.ok) {
      throw new Error(`Download fehlgeschlagen (${res.status}): ${res.statusText}`);
    }

    const totalBytes = Number(res.headers.get('content-length') || asset.size || 0);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Konnte Download-Strom nicht initialisieren.');

    const tempFile = targetFile + '.part';
    const fileHandle = await fsp.open(tempFile, 'w');

    let transferred = 0;
    let lastTime = Date.now();
    let bytesSinceLast = 0;
    let bytesPerSecond = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          await fileHandle.write(value);
          transferred += value.length;
          bytesSinceLast += value.length;

          const now = Date.now();
          const elapsed = now - lastTime;
          if (elapsed >= 500) {
            bytesPerSecond = Math.round((bytesSinceLast / elapsed) * 1000);
            bytesSinceLast = 0;
            lastTime = now;
            const percent = totalBytes > 0 ? Math.round((transferred / totalBytes) * 100) : 0;
            emitProgress({ percent, transferred, total: totalBytes, bytesPerSecond });
          }
        }
      }
    } finally {
      await fileHandle.close();
    }

    // Nur eine Datei installieren, die der von GitHub gemeldeten Prüfsumme entspricht.
    if (asset.digest?.startsWith('sha256:') && (await sha256(tempFile)) !== asset.digest.slice(7).toLowerCase()) {
      await fsp.rm(tempFile, { force: true });
      throw new Error('Die Prüfsumme des Downloads stimmt nicht – Update verworfen.');
    }
    await fsp.rename(tempFile, targetFile);
    downloadedTag = state.updateInfo?.tag;

    // Auf Linux ausführbar machen
    if (process.platform === 'linux') {
      try {
        await fsp.chmod(targetFile, 0o755);
      } catch {
        /* ignore */
      }
    }

    state = {
      ...state,
      status: 'downloaded',
      downloadPath: targetFile,
      progress: {
        percent: 100,
        transferred: totalBytes || transferred,
        total: totalBytes || transferred,
        bytesPerSecond: 0,
      },
    };
    emitStatus();
    return true;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    state = { ...state, status: 'error', error: errorMsg };
    emitStatus();
    return false;
  }
}

export async function installUpdate(): Promise<boolean> {
  const filePath = state.downloadPath;
  if (!filePath) {
    state = { ...state, status: 'error', error: 'Keine heruntergeladene Datei vorhanden.' };
    emitStatus();
    return false;
  }

  // Seit dem Download kann eine neuere Version gefunden worden sein: dann nicht stillschweigend die ältere installieren.
  if (downloadedTag && state.updateInfo?.tag && downloadedTag !== state.updateInfo.tag) {
    state = { ...state, status: 'available', downloadPath: undefined, error: undefined };
    emitStatus();
    return false;
  }

  try {
    await fsp.access(filePath);
  } catch {
    state = { ...state, status: 'error', error: 'Update-Datei wurde nicht gefunden.' };
    emitStatus();
    return false;
  }

  if (process.platform === 'linux' && !filePath.endsWith('.AppImage')) {
    // Ein .deb lässt sich nicht als AppImage starten: dem Nutzer zur Installation zeigen.
    shell.showItemInFolder(filePath);
    return false;
  }
  if (process.platform === 'linux') {
    // Linux AppImage Update
    const currentAppImage = process.env.APPIMAGE;
    const defaultAppImage = join(homedir(), '.local', 'share', 'ai-hub', 'Quorum.AppImage');
    const targetInstallPath = currentAppImage || defaultAppImage;

    const binLink = join(homedir(), '.local', 'bin', 'quorum');
    const desktopFile = join(homedir(), '.local', 'share', 'applications', 'quorum.desktop');

    try {
      await fsp.mkdir(join(targetInstallPath, '..'), { recursive: true });
      await fsp.mkdir(join(binLink, '..'), { recursive: true });
      await fsp.mkdir(join(desktopFile, '..'), { recursive: true });

      // Skript für nahtlosen Neustart und Austausch im Hintergrund vorbereiten
      const updaterScript = join(dataDir(), 'updates', 'apply-update.sh');
      // Pfade kommen als Argumente statt in den Skripttext, damit Sonderzeichen nichts auslösen. Erst wenn die App wirklich
      // beendet ist, wird ausgetauscht – bricht der Nutzer das Beenden ab, bleibt die Installation unberührt.
      const scriptContent = `#!/usr/bin/env bash
src="$1"; dst="$2"; link="$3"; pid="$4"
for _ in $(seq 1 900); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$pid" 2>/dev/null; then exit 0; fi
cp -f "$src" "$dst.new" && chmod +x "$dst.new" && mv -f "$dst.new" "$dst" || exit 1
ln -sf "$dst" "$link"
setsid "$dst" >/dev/null 2>&1 &
rm -f "$src"
`;
      await fsp.writeFile(updaterScript, scriptContent, { mode: 0o755 });

      // Starte das Update-Skript entkoppelt
      const child = spawn('/bin/bash', [updaterScript, filePath, targetInstallPath, binLink, String(process.pid)], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      // App sauber beenden
      app.quit();
      return true;
    } catch (err: unknown) {
      // Fallback: Datei im Ordner anzeigen
      shell.showItemInFolder(filePath);
      return false;
    }
  }
  if (process.platform === 'win32' && filePath.toLowerCase().endsWith('.exe')) {
    // Windows: Installer starten und die App beenden, damit er die Dateien ersetzen kann.
    // Erst beenden, wenn der Installer wirklich läuft; ein fehlgeschlagener Start darf den Hauptprozess nicht mitreißen.
    const installer = spawn(filePath, [], { detached: true, stdio: 'ignore' });
    installer.once('error', () => { shell.showItemInFolder(filePath); });
    installer.once('spawn', () => { installer.unref(); app.quit(); });
    return true;
  }
  if (process.platform === 'darwin' && filePath.toLowerCase().endsWith('.dmg')) {
    // macOS: Image einhängen – die App wird wie gewohnt nach „Programme“ gezogen.
    const failure = await shell.openPath(filePath);
    return !failure;
  }
  shell.showItemInFolder(filePath);
  return true;
}

export function getUpdateState(): UpdateState {
  return { ...state };
}
