import { app } from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedBlender, sandboxed, toolsDir } from './tools';

export interface BlenderOp {
  op: 'load' | 'info' | 'decimate' | 'smooth' | 'export' | 'render' | 'pose' | 'bbmodel_to_scene' | 'save_blend';
  [key: string]: unknown;
}

export interface BlenderResult {
  ok: boolean;
  results: { op: string; result: unknown }[];
  error?: string;
  /** Letzte Zeilen der Blender-Ausgabe (für das Protokoll). */
  log: string;
}

const TIMEOUT_MS = 10 * 60 * 1000;

/** Blender-Programm: ausdrücklich gesetzt (QUORUM_BLENDER), sonst die neueste portable Installation, sonst PATH. */
export function findBlender(): string | undefined {
  const env = process.env.QUORUM_BLENDER;
  if (env && existsSync(env)) return env;
  if (existsSync(managedBlender())) return managedBlender();
  const portable = join(homedir(), '.local', 'opt');
  if (existsSync(portable)) {
    const dirs = readdirSync(portable).filter((d) => d.startsWith('blender-')).sort().reverse();
    for (const d of dirs) {
      const bin = join(portable, d, 'blender');
      if (existsSync(bin)) return bin;
    }
  }
  try {
    return execFileSync('which', ['blender'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Versionsangabe für die Oberfläche. */
export function blenderVersion(bin: string): string | undefined {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 60000 }).split('\n')[0]?.trim();
  } catch {
    return undefined;
  }
}

export function pythonDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'python') : fileURLToPath(new URL('../python/', import.meta.url));
}

/** Operationsskript im Projekt (liegt neben dem Quellcode bzw. in den Zusatzressourcen). */
export function blenderScript(dir = pythonDir()): string {
  return join(dir, 'blender_ops.py');
}

/** Führt eine Folge von Operationen in `workdir` aus. Jeder Pfad muss im Arbeitsordner liegen. */
export function runBlenderOps(opts: { bin: string; script: string; workdir: string; ops: BlenderOp[]; signal?: AbortSignal }): Promise<BlenderResult> {
  mkdirSync(opts.workdir, { recursive: true });
  const jobPath = join(opts.workdir, `.job-${Date.now()}.json`);
  writeFileSync(jobPath, JSON.stringify({ workdir: resolve(opts.workdir), ops: opts.ops }));
  return new Promise((resolveRun) => {
    const args = ['-b', '--factory-startup', '--python', opts.script, '--', jobPath];
    // Eigeninstallation: in der Sandbox ohne Netzwerk; sie sieht nur Blender, das Skript und den Projektordner.
    const managed = resolve(opts.bin).startsWith(resolve(toolsDir()) + sep);
    const run = managed
      ? sandboxed(opts.bin, args, { rw: [resolve(opts.workdir)], ro: [dirname(resolve(opts.bin)), dirname(resolve(opts.script))], net: false, gui: false })
      : { cmd: opts.bin, args, env: { PATH: process.env.PATH ?? '', HOME: homedir(), LANG: 'C.UTF-8' } as NodeJS.ProcessEnv };
    const child = spawn(run.cmd, run.args, {
      cwd: opts.workdir,
      env: run.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const results: { op: string; result: unknown }[] = [];
    let error: string | undefined;
    let done = false;
    let buf = '';
    let log = '';
    const timer = setTimeout(() => { error = 'Zeitlimit überschritten'; kill(); }, TIMEOUT_MS);
    const kill = () => {
      try { if (process.platform === 'win32') child.kill(); else if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    };
    const onAbort = () => { error = 'Abgebrochen'; kill(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const line = (l: string) => {
      log = (log + l + '\n').slice(-4000);
      const m = /^(RESULT|ERROR|DONE) (.*)$/.exec(l);
      if (!m) return;
      try {
        const data = JSON.parse(m[2]) as { op?: string; result?: unknown; message?: string };
        if (m[1] === 'RESULT') results.push({ op: data.op ?? '', result: data.result });
        if (m[1] === 'ERROR') error = data.message ?? 'Blender-Fehler';
        if (m[1] === 'DONE') done = true;
      } catch { /* kein gültiges Ergebnis */ }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { log = (log + c).slice(-4000); });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      try { unlinkSync(jobPath); } catch { /* schon weg */ }
      const ok = !error && done && code === 0;
      resolveRun({ ok, results, error: ok ? undefined : error ?? `Blender beendet (Code ${code})`, log });
    };
    child.on('error', (e) => { error = e.message; finish(null); });
    child.on('close', (code) => finish(code));
  });
}

/** Sicherstellen, dass ein Pfad im Projektordner liegt (für Aufrufer, die Pfade aus Eingaben übernehmen). */
export function insideDir(dir: string, path: string): boolean {
  const root = resolve(dir);
  const p = resolve(dir, path);
  return p === root || p.startsWith(root + sep);
}
