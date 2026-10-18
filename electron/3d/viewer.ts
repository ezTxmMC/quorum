// Live-Ansicht: Blockbench läuft headless (ohne Fenster) mit eigenem Profil, öffnet das Modell und liefert seine
// Darstellung als Bildstrom über das Debug-Protokoll. Die Oberfläche zeigt den Strom in einem Panel.
// Änderungen am Modell: Instanz neu starten (Blockbench lädt Dateien beim Start). Jede Instanz hat einen eigenen Port.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';

export const BLOCKBENCH_DEFAULT = '/opt/blockbench/blockbench';

export function findBlockbench(): string | undefined {
  const env = process.env.QUORUM_BLOCKBENCH;
  if (env && existsSync(env)) return env;
  return existsSync(BLOCKBENCH_DEFAULT) ? BLOCKBENCH_DEFAULT : undefined;
}

interface Session {
  proc: ChildProcess;
  ws: WebSocket;
  file: string;
  stopped: boolean;
  timer?: ReturnType<typeof setInterval>;
}

const sessions = new Map<string, Session>();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Seite der Blockbench-Instanz finden (bis sie geladen ist). */
async function waitPage(port: number, timeoutMs = 60000): Promise<{ url: string; webSocketDebuggerUrl: string }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[];
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return { url: page.url, webSocketDebuggerUrl: page.webSocketDebuggerUrl };
    } catch { /* noch nicht bereit */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Blockbench ist nicht rechtzeitig gestartet');
}

export interface ViewerOptions {
  projectId: string;
  file: string;
  profileDir: string;
  bin: string;
  onFrame: (jpeg: string) => void;
  onError: (message: string) => void;
}

/** Headless-Blockbench für ein Projekt starten (ersetzt eine vorhandene Ansicht desselben Projekts). */
export async function openViewer(opts: ViewerOptions): Promise<void> {
  await closeViewer(opts.projectId);
  mkdirSync(opts.profileDir, { recursive: true });
  const port = await freePort();
  const proc = spawn(opts.bin, ['--ozone-platform=headless', '--use-gl=angle', `--user-data-dir=${opts.profileDir}`, `--remote-debugging-port=${port}`, opts.file], {
    stdio: 'ignore',
    detached: true,
  });
  let page;
  try {
    page = await waitPage(port);
  } catch (e) {
    try { proc.kill('SIGTERM'); } catch { /* beendet */ }
    throw e;
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const session: Session = { proc, ws, file: opts.file, stopped: false };
  sessions.set(opts.projectId, session);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('Verbindung zu Blockbench fehlgeschlagen')), { once: true });
  });
  // Antworten auf Anfragen über die ID zuordnen.
  let id = 0;
  const pending = new Map<number, (r: { result?: Record<string, unknown> }) => void>();
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(String(m.data)) as { id?: number; result?: Record<string, unknown> };
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: Record<string, unknown> }>((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  // Nur der Vorschaubereich mit dem Modell: Position des Vorschau-Elements abfragen, dann genau diesen Ausschnitt aufnehmen.
  const rectExpr = "(()=>{const p=document.querySelector('#preview'); if(!p) return null; const r=p.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};})()";
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || session.stopped) return;
    busy = true;
    try {
      const rect = (await call('Runtime.evaluate', { expression: rectExpr, returnByValue: true })).result as { result?: { value?: { x: number; y: number; width: number; height: number } | null } } | undefined;
      const r = rect?.result?.value;
      if (r && r.width > 1 && r.height > 1) {
        const shot = await call('Page.captureScreenshot', { format: 'jpeg', quality: 75, clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } });
        const data = (shot.result as { data?: string } | undefined)?.data;
        if (data) opts.onFrame(data);
      }
    } catch { /* nächster Versuch */ } finally { busy = false; }
  }, 700);
  session.timer = timer;
  proc.on('exit', () => {
    if (!session.stopped) { sessions.delete(opts.projectId); opts.onError('Blockbench wurde beendet'); }
  });
}

/** Ansicht beenden und den Prozess dieser Instanz stoppen. */
export async function closeViewer(projectId: string): Promise<boolean> {
  const s = sessions.get(projectId);
  if (!s) return false;
  s.stopped = true;
  if (s.timer) clearInterval(s.timer);
  sessions.delete(projectId);
  try { s.ws.close(); } catch { /* schon zu */ }
  try { process.kill(-(s.proc.pid ?? 0), 'SIGTERM'); } catch { s.proc.kill('SIGTERM'); }
  // Warten, bis der Prozess weg ist: sonst hält er das Profil noch und die nächste Instanz beendet sich sofort.
  await new Promise<void>((resolve) => {
    if (s.proc.exitCode !== null || s.proc.signalCode !== null) return resolve();
    const t = setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch { /* beendet */ } resolve(); }, 5000);
    s.proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
  return true;
}

/** Blockbench mit sichtbarem Fenster öffnen (eigenes Profil, läuft unabhängig von der Oberfläche). */
export function openWindow(bin: string, file: string, profileDir: string): void {
  mkdirSync(profileDir, { recursive: true });
  const proc = spawn(bin, [`--user-data-dir=${profileDir}`, file], { stdio: 'ignore', detached: true });
  proc.unref();
}

export const hasViewer = (projectId: string) => sessions.has(projectId);
