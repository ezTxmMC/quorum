import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { PROVIDERS } from '../../shared/catalog';
import { CLI_PACKAGES, npmInstallArgs, type HostInstallPlan, type InstallCheck } from '../../shared/cli-packages';
import type { SandboxResult } from '../../shared/sandbox';
import type { ProviderId } from '../../shared/types';
import { findOnPath } from './acp';
import { execCli, resolveBinary } from './detect';
import { sandboxLaunch } from './sandbox';

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

/** Wohin installiert wird. Tests geben einen eigenen Ort vor, damit sie das echte Benutzerverzeichnis nie anfassen. */
export interface InstallTarget {
  /** npm-Präfix; undefined = Standard von npm (Windows: der Ordner liegt dort bereits im PATH). */
  prefix?: string;
  binDir: string;
  /** Ordner mit den Paketdateien. */
  moduleDir: string;
}

const installing = new Set<ProviderId>();

function probe(file: string, args: string[]): Promise<string> {
  return new Promise((done) => {
    let launch: ReturnType<typeof sandboxLaunch>;
    try {
      launch = sandboxLaunch(file, args);
    } catch {
      done('');
      return;
    }
    execFile(launch.cmd, launch.args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: launch.verbatim }, (error, stdout) => done(error ? '' : String(stdout).trim()));
  });
}

/** Unix: ~/.local – der übliche Ort für Programme eines Benutzers, ohne Administratorrechte. Windows: der npm-Standardordner. */
export async function defaultTarget(npm: string): Promise<InstallTarget | undefined> {
  if (process.platform !== 'win32') {
    const prefix = join(homedir(), '.local');
    return { prefix, binDir: join(prefix, 'bin'), moduleDir: join(prefix, 'lib', 'node_modules') };
  }
  const prefix = await probe(npm, ['config', 'get', 'prefix']);
  return prefix ? { binDir: prefix, moduleDir: join(prefix, 'node_modules') } : undefined;
}

/** existsSync folgt Verknüpfungen; eine kaputte Verknüpfung am Zielort würde es übersehen. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function writableOrCreatable(dir: string): boolean {
  let current = resolve(dir);
  while (!existsSync(current) && dirname(current) !== current) {
    current = dirname(current);
  }
  try {
    accessSync(current, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function sameDir(a: string, b: string): boolean {
  const normalize = (value: string) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
  return normalize(a) === normalize(b);
}

function nodeAtLeast(version: string, [major, minor]: [number, number]): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return false;
  }
  return Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor);
}

/**
 * Prüft alles, was vor einer Installation feststehen muss – ohne etwas zu verändern. Installiert wird nur, wenn die CLI
 * noch nirgends gefunden wird und am Zielort nichts liegt: eine bestehende Installation wird nie ersetzt oder überschrieben.
 */
export async function hostInstallPlan(provider: ProviderId, hostBinaries: Partial<Record<ProviderId, string>>, forcedTarget?: InstallTarget): Promise<HostInstallPlan> {
  const pkg = CLI_PACKAGES[provider];
  if (!pkg) {
    return { provider, available: false, ready: false, checks: [] };
  }
  const checks: InstallCheck[] = [];
  const bin = PROVIDERS[provider].bin;
  const existing = forcedTarget ? undefined : resolveBinary(provider, hostBinaries);
  checks.push(existing ? { ok: false, text: `Bereits installiert: ${existing}` } : { ok: true, text: `${bin} ist noch nicht installiert` });

  const npm = findOnPath('npm');
  const node = findOnPath('node');
  const nodeVersion = node ? await probe(node, ['--version']) : '';
  const required = pkg.minNode.join('.');
  if (!npm || !node) {
    checks.push({ ok: false, text: 'Node.js mit npm wurde nicht gefunden – bitte zuerst Node.js installieren' });
  } else if (!nodeAtLeast(nodeVersion, pkg.minNode)) {
    checks.push({ ok: false, text: `Node.js ${nodeVersion || '?'} ist zu alt – das Paket braucht mindestens ${required}` });
  } else {
    checks.push({ ok: true, text: `Node.js ${nodeVersion} (mindestens ${required} nötig)` });
  }

  const target = forcedTarget ?? (npm ? await defaultTarget(npm) : undefined);
  if (!target) {
    checks.push({ ok: false, text: 'Der Installationsordner von npm konnte nicht ermittelt werden' });
    return { provider, available: true, ready: false, package: pkg.name, checks };
  }
  const names = process.platform === 'win32' ? [bin, `${bin}.cmd`, `${bin}.ps1`] : [bin];
  const blocker = [...names.map((name) => join(target.binDir, name)), join(target.moduleDir, ...pkg.name.split('/'))].find(occupied);
  checks.push(blocker ? { ok: false, text: `Am Zielort liegt bereits etwas: ${blocker}` } : { ok: true, text: `Zielort ist frei: ${join(target.binDir, bin)}` });
  checks.push(writableOrCreatable(target.binDir) && writableOrCreatable(target.moduleDir)
    ? { ok: true, text: 'Zielordner ist ohne Administratorrechte beschreibbar' }
    : { ok: false, text: `Keine Schreibrechte für ${target.binDir}` });
  const inPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => sameDir(dir, target.binDir));
  // Diese Ordner durchsucht Quorum auch dann, wenn sie nicht im PATH stehen.
  const known = [join(homedir(), '.local', 'bin'), ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : [])].some((dir) => sameDir(dir, target.binDir));
  if (inPath) {
    checks.push({ ok: true, text: `${target.binDir} liegt im PATH` });
  } else if (known || forcedTarget) {
    checks.push({ ok: true, warning: true, text: `${target.binDir} liegt nicht im PATH: Quorum findet die CLI trotzdem, im eigenen Terminal musst du den Ordner selbst zum PATH hinzufügen` });
  } else {
    checks.push({ ok: false, text: `${target.binDir} liegt nicht im PATH – die CLI wäre nach der Installation nicht auffindbar` });
  }

  const command = ['npm', ...npmInstallArgs(pkg.name, target.prefix)].join(' ');
  return { provider, available: true, ready: checks.every((check) => check.ok), package: pkg.name, command, binDir: target.binDir, checks };
}

function runNpm(npm: string, args: string[], onLine: (text: string) => void): Promise<SandboxResult> {
  return new Promise((done) => {
    const launch = sandboxLaunch(npm, args);
    const child = spawn(launch.cmd, launch.args, { env: launch.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
    const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_TIMEOUT_MS);
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) {
          onLine(line);
        }
      }
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? { ok: true } : { ok: false, error: `npm wurde mit Code ${code} beendet` });
    });
  });
}

/** Installiert die CLI für den Benutzer. Der Plan wird unmittelbar vorher neu geprüft, damit sich zwischen Anzeige und Start nichts geändert haben kann. */
export async function installOnHost(provider: ProviderId, hostBinaries: Partial<Record<ProviderId, string>>, onLine: (text: string) => void, forcedTarget?: InstallTarget): Promise<SandboxResult> {
  if (installing.has(provider)) {
    return { ok: false, error: 'Die Installation läuft bereits.' };
  }
  installing.add(provider);
  try {
    const plan = await hostInstallPlan(provider, hostBinaries, forcedTarget);
    const failed = plan.checks.find((check) => !check.ok);
    const npm = findOnPath('npm');
    const pkg = CLI_PACKAGES[provider];
    if (!plan.ready || !npm || !pkg) {
      return { ok: false, error: failed?.text ?? 'Für diesen Anbieter gibt es kein Paket.' };
    }
    const target = forcedTarget ?? (await defaultTarget(npm));
    const result = await runNpm(npm, npmInstallArgs(pkg.name, target?.prefix), onLine);
    if (!result.ok) {
      return result;
    }
    // Auf Windows legt npm zusätzlich ein Shell-Skript ohne Endung ab, das sich nicht direkt starten lässt.
    const names = process.platform === 'win32' ? [`${PROVIDERS[provider].bin}.cmd`, `${PROVIDERS[provider].bin}.exe`] : [PROVIDERS[provider].bin];
    const installed = target ? names.map((name) => join(target.binDir, name)).find((file) => existsSync(file)) : undefined;
    if (!installed) {
      return { ok: false, error: `npm lief durch, aber „${PROVIDERS[provider].bin}“ liegt nicht im Zielordner.` };
    }
    const version = await execCli(installed, ['--version'], undefined, 30_000);
    return version.ok ? { ok: true } : { ok: false, error: `Installiert, aber der Start schlägt fehl: ${(version.stderr || version.stdout).trim().slice(0, 300)}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    installing.delete(provider);
  }
}
