// Python-Umgebung für Transformers und Diffusers: eigene venv im Datenordner, Pins aus python/requirements.txt.
// Torch (ROCm/CUDA) kommt vom System (--system-site-packages), damit keine mehrere GB großen Wheels geladen werden.
// PYTHONNOUSERSITE=1 verhindert, dass Pakete aus ~/.local die Umgebung verunreinigen.
// Es werden nur die gepinnten Pakete aus requirements.txt installiert – keine Installationsskripte.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PyStatus {
  /** Umgebung eingerichtet und zu den Pins passend. */
  ready: boolean;
  python?: string;
  pythonVersion?: string;
  torch?: { version: string; hip?: string; cuda: boolean; device?: string };
  error?: string;
}

const PY_BIN = process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python');
const MARKER = 'installed.json';

export function envDir(dataRoot: string): string {
  return join(dataRoot, 'python', 'venv');
}

export function venvPython(dataRoot: string): string {
  return join(envDir(dataRoot), PY_BIN);
}

function requirementsHash(requirements: string): string {
  return createHash('sha256').update(readFileSync(requirements)).digest('hex');
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}\n${stderr}`.trim() });
    });
  });
}

/** Basis-Interpreter: `python3` aus dem PATH (3.10 oder neuer). */
export async function basePython(): Promise<{ path: string; version: string } | undefined> {
  for (const candidate of ['python3', 'python']) {
    const r = await run(candidate, ['-c', 'import sys;print(sys.version.split()[0])'], process.env, 15000);
    if (r.ok) {
      const version = r.out.split('\n')[0].trim();
      const [major, minor] = version.split('.').map(Number);
      if (major === 3 && minor >= 10) return { path: candidate, version };
    }
  }
  return undefined;
}

/** Torch-Angaben aus der venv (Backend, Gerät). Läuft isoliert und ohne Benutzerpakete. */
async function torchInfo(py: string): Promise<PyStatus['torch'] | undefined> {
  const code = 'import json,torch;d=torch.cuda.is_available();print(json.dumps({"version":torch.__version__,"hip":getattr(torch.version,"hip",None),"cuda":d,"device":torch.cuda.get_device_name(0) if d else None}))';
  const env = { ...process.env, PYTHONNOUSERSITE: '1' };
  const r = await run(py, ['-I', '-c', code], env, 120000);
  if (!r.ok) return undefined;
  try {
    return JSON.parse(r.out.split('\n').filter((l) => l.startsWith('{')).pop() ?? '') as PyStatus['torch'];
  } catch {
    return undefined;
  }
}

/** Prüft, ob die venv existiert, zu den Pins passt und Torch sieht. */
export async function pyStatus(dataRoot: string, requirements: string): Promise<PyStatus> {
  const py = venvPython(dataRoot);
  const marker = join(envDir(dataRoot), MARKER);
  if (!existsSync(py)) return { ready: false, error: 'Umgebung nicht eingerichtet' };
  let installed: { hash?: string; python?: string } = {};
  try { installed = JSON.parse(readFileSync(marker, 'utf8')) as typeof installed; } catch { /* fehlt */ }
  const ver = await run(py, ['-I', '-c', 'import sys;print(sys.version.split()[0])'], { ...process.env, PYTHONNOUSERSITE: '1' }, 15000);
  const torch = await torchInfo(py);
  const ready = installed.hash === requirementsHash(requirements) && !!torch;
  return {
    ready,
    python: py,
    pythonVersion: ver.ok ? ver.out.split('\n')[0].trim() : undefined,
    torch,
    error: ready ? undefined : installed.hash !== requirementsHash(requirements) ? 'Pakete sind nicht aktuell (Einrichtung wiederholen)' : 'Torch ist nicht verfügbar',
  };
}

/**
 * Richtet die Umgebung ein bzw. aktualisiert sie. `onLog` erhält die Ausgabe von pip (zeilenweise).
 * Bricht bei Fehlern mit einer Meldung ab; eine bestehende, passende Umgebung wird nicht neu installiert.
 */
export async function setupPyEnv(dataRoot: string, requirements: string, onLog: (line: string) => void): Promise<PyStatus> {
  const base = await basePython();
  if (!base) throw new Error('Kein Python 3.10+ gefunden (python3 im PATH).');
  const dir = envDir(dataRoot);
  mkdirSync(join(dataRoot, 'python'), { recursive: true });
  const env = { ...process.env, PYTHONNOUSERSITE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUNBUFFERED: '1' };
  if (!existsSync(venvPython(dataRoot))) {
    onLog(`venv anlegen: ${dir}`);
    const v = await run(base.path, ['-m', 'venv', '--system-site-packages', dir], env, 300000);
    if (!v.ok) throw new Error(`venv fehlgeschlagen: ${v.out.slice(-400)}`);
  }
  const py = venvPython(dataRoot);
  onLog('pip install -r requirements.txt …');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const feed = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) { onLog(line.trim()); tail = (tail + '\n' + line).slice(-2000); }
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pip fehlgeschlagen (Code ${code}): ${tail.slice(-400)}`))));
  });
  writeFileSync(join(dir, MARKER), JSON.stringify({ hash: requirementsHash(requirements), python: base.version, at: Date.now() }));
  return pyStatus(dataRoot, requirements);
}
