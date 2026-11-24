import { app, shell } from 'electron';
import { createReadStream, promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    // Eine per Paket installierte App aktualisiert sich über das .deb; das AppImage ersetzte dort nur eine Kopie im Home-Ordner.
    const order = !process.env.APPIMAGE && app.isPackaged ? ['.deb', '.AppImage'] : ['.AppImage', '.deb'];
    match = assets.find((a) => a.name.endsWith(order[0])) || assets.find((a) => a.name.endsWith(order[1]));
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

/** Bereits ausgetauschtes AppImage: bricht der Nutzer das Beenden ab, startet der nächste Klick nur noch neu. */
let installedAppImage: string | undefined;

/** Ohne laufenden Dienst schreibt niemand den Starter neu; dann wäre das Warten vergeblich. */
function integrationDaemonRuns(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn('pgrep', ['-f', 'appimagelauncherd'], { stdio: 'ignore' });
    probe.once('error', () => resolve(false));
    probe.once('close', (code) => resolve(code === 0));
  });
}

/**
 * Wartet, bis eine Desktop-Integration (AppImageLauncher) das ausgetauschte AppImage neu eingebunden hat.
 * Sie schreibt den Starter erst einige Sekunden nach dem Austausch neu; ein Neustart davor läuft in diese Umstellung hinein.
 */
async function desktopIntegrationSettled(appImage: string, since: number): Promise<void> {
  const directory = join(homedir(), '.local', 'share', 'applications');
  const starters: string[] = [];
  for (const name of await fsp.readdir(directory).catch(() => [] as string[])) {
    if (!name.startsWith('appimagekit_') || !name.endsWith('.desktop')) {
      continue;
    }
    const content = await fsp.readFile(join(directory, name), 'utf8').catch(() => '');
    if (content.includes(appImage)) {
      starters.push(join(directory, name));
    }
  }
  if (!starters.length || !(await integrationDaemonRuns())) {
    return;
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const stats = await Promise.all(starters.map((file) => fsp.stat(file).catch(() => undefined)));
    if (stats.some((stat) => stat && stat.mtimeMs >= since)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

const STALE_VARIABLES = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'TARGET_APPIMAGE', 'REDIRECT_APPIMAGE', 'CHROME_DESKTOP', 'GIO_LAUNCHED_DESKTOP_FILE', 'GIO_LAUNCHED_DESKTOP_FILE_PID'];

/**
 * Umgebung für Prozesse, die diese Instanz überleben. Das AppImage setzt Pfade in seinen eigenen Mount (Bibliotheken,
 * PATH); mit dem Ende der App verschwindet der Mount, und ein damit gestartetes AppImage scheitert schon beim Start.
 */
function detachedEnvironment(): NodeJS.ProcessEnv {
  const mount = process.env.APPDIR;
  const stale = (entry: string) => entry.startsWith('/tmp/.mount_') || (!!mount && entry.startsWith(mount));
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || STALE_VARIABLES.includes(name)) {
      continue;
    }
    const kept = value.split(':').filter((entry) => !stale(entry));
    if (kept.length > 0 || value === '') {
      environment[name] = kept.join(':');
    }
  }
  return environment;
}

/** Mitgeliefertes Update-Fenster (native/updater); fehlt in Entwicklungsständen ohne gebautes Rust-Programm. */
function bundledUpdater(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'updater', 'quorum-updater')
    : join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'bin', 'quorum-updater');
}

/**
 * Übergibt das Update an das eigenständige Update-Fenster: es wartet auf das Ende dieser App, tauscht das AppImage aus,
 * zeigt solange den Fortschritt und startet danach die neue Version. Liefert false, wenn das Programm nicht verfügbar ist.
 */
async function handOverToUpdater(filePath: string, target: string, binLink: string, language: string, switches: string[]): Promise<boolean> {
  // Aus dem AppImage heraus würde das Programm mit dem Ende der App seine eigene Datei verlieren, deshalb läuft eine Kopie.
  const copy = join(dataDir(), 'updates', 'quorum-updater');
  try {
    await fsp.mkdir(dirname(copy), { recursive: true });
    await fsp.copyFile(bundledUpdater(), copy);
    await fsp.chmod(copy, 0o755);
  } catch {
    return false;
  }
  const args = ['--source', filePath, '--target', target, '--pid', String(process.pid), '--link', binLink, '--lang', language, '--', ...switches];
  return new Promise((resolve) => {
    const child = spawn(copy, args, { detached: true, stdio: 'ignore', env: detachedEnvironment() });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** Installiert das AppImage und startet erst neu, wenn die neue Version eingerichtet ist. */
async function installAppImage(filePath: string, language: string): Promise<boolean> {
  const target = process.env.APPIMAGE || join(homedir(), '.local', 'share', 'ai-hub', 'Quorum.AppImage');
  const binLink = join(homedir(), '.local', 'bin', 'quorum');
  // Ohne den Schalter startet Electron aus einem AppImage auf Systemen ohne freie User-Namespaces nicht.
  const switches = process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : [];
  if (installedAppImage !== target && (await handOverToUpdater(filePath, target, binLink, language, switches))) {
    app.quit();
    return true;
  }
  // Ohne Update-Fenster: im laufenden Betrieb austauschen und danach neu starten.
  try {
    if (installedAppImage !== target) {
      state = { ...state, status: 'installing', error: undefined };
      emitStatus();
      const started = Date.now();
      await fsp.mkdir(join(target, '..'), { recursive: true });
      // Umbenennen ersetzt nur den Verzeichniseintrag: die laufende App behält ihre alte Datei, bis sie endet.
      await fsp.copyFile(filePath, `${target}.new`);
      await fsp.chmod(`${target}.new`, 0o755);
      await fsp.rename(`${target}.new`, target);
      installedAppImage = target;
      await fsp.mkdir(join(binLink, '..'), { recursive: true });
      await fsp.rm(binLink, { force: true });
      await fsp.symlink(target, binLink).catch(() => undefined);
      await desktopIntegrationSettled(target, started);
      await fsp.rm(filePath, { force: true });
    }

    // Die neue App kann erst starten, wenn diese beendet ist (nur eine Instanz). Bricht der Nutzer das Beenden ab,
    // gibt das Skript nach 90 s auf; die neue Version ist dann trotzdem installiert und gilt ab dem nächsten Start.
    const relaunchScript = join(dataDir(), 'updates', 'apply-update.sh');
    const scriptContent = `#!/usr/bin/env bash
app="$1"; pid="$2"; shift 2
for _ in $(seq 1 900); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$pid" 2>/dev/null; then exit 0; fi
setsid "$app" "$@" >/dev/null 2>&1 &
`;
    await fsp.mkdir(join(relaunchScript, '..'), { recursive: true });
    await fsp.writeFile(relaunchScript, scriptContent, { mode: 0o755 });
    const child = spawn('/bin/bash', [relaunchScript, target, String(process.pid), ...switches], { detached: true, stdio: 'ignore', env: detachedEnvironment() });
    child.unref();
    state = { ...state, status: 'downloaded', error: undefined };
    emitStatus();
    app.quit();
    return true;
  } catch (err: unknown) {
    await fsp.rm(`${target}.new`, { force: true }).catch(() => undefined);
    state = { ...state, status: 'error', error: `Update konnte nicht installiert werden: ${err instanceof Error ? err.message : String(err)}` };
    emitStatus();
    return false;
  }
}

export async function installUpdate(language: 'de' | 'en' = 'en'): Promise<boolean> {
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

  if (process.platform === 'linux' && installedAppImage) {
    return installAppImage(filePath, language);
  }

  try {
    await fsp.access(filePath);
  } catch {
    state = { ...state, status: 'error', error: 'Update-Datei wurde nicht gefunden.' };
    emitStatus();
    return false;
  }

  if (process.platform === 'linux' && !filePath.endsWith('.AppImage')) {
    // Ein .deb braucht Administratorrechte: mit der Paketverwaltung des Systems öffnen, notfalls im Ordner zeigen.
    if (await shell.openPath(filePath)) {
      shell.showItemInFolder(filePath);
    }
    return true;
  }
  if (process.platform === 'linux') {
    return installAppImage(filePath, language);
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
