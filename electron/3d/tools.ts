// Eigene Installation von Blender und Blockbench (inkl. Community-MCP-Plugin) im Datenordner der App.
// Beide Werkzeuge sind einzeln installierbar, liegen komplett in ~/.config/ai-hub/tools und laufen – wenn
// bubblewrap vorhanden ist – in einer Sandbox, die nur Werkzeugordner und Projektordner sieht.
import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync, promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { dataDir } from '../store';
import type { ToolId, ToolStatus } from '../../shared/threed';

export const toolsDir = () => join(dataDir(), 'tools');
const dirOf = (id: ToolId) => join(toolsDir(), id);

const BLOCKBENCH_REPO = 'JannisX11/blockbench';
const MCP_REPO = 'jasonjgardner/blockbench-mcp-plugin';

/** Blender-Programm der Eigeninstallation. */
export const managedBlender = () => join(dirOf('blender'), 'blender');
/** Blockbench der Eigeninstallation (entpacktes AppImage, kein FUSE nötig). */
export const managedBlockbench = () => join(dirOf('blockbench'), 'app', 'AppRun');
export const mcpPluginFile = () => join(dirOf('blockbench'), 'plugins', 'mcp.js');

let bwrapPath: string | null | undefined;
/** Pfad von bubblewrap, falls installiert. */
export function findBwrap(): string | null {
  if (bwrapPath !== undefined) return bwrapPath;
  bwrapPath = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find((p) => existsSync(p)) ?? null;
  return bwrapPath;
}

export interface SandboxOpts {
  /** Ordner, die beschreibbar eingebunden werden (Projekt, Profil). */
  rw: string[];
  /** Ordner nur lesend (Werkzeug, Skripte). */
  ro: string[];
  /** Netzwerk erlauben (Blockbench braucht Loopback für Debug-Port und MCP). */
  net: boolean;
  /** Fenster/GPU: Display-Sockets und /dev/dri durchreichen. */
  gui: boolean;
  env?: Record<string, string>;
}

/** Baut den Aufruf: mit bubblewrap in einer Sandbox, sonst direkt mit bereinigter Umgebung. */
export function sandboxed(bin: string, args: string[], o: SandboxOpts): { cmd: string; args: string[]; sandboxed: boolean; env: NodeJS.ProcessEnv } {
  const home = o.rw[0] ?? toolsDir();
  const baseEnv: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', ...o.env };
  if (o.gui) for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY']) if (process.env[k]) baseEnv[k] = process.env[k];
  const bwrap = findBwrap();
  if (!bwrap) return { cmd: bin, args, sandboxed: false, env: baseEnv };
  const a = ['--die-with-parent', '--new-session', '--unshare-all', ...(o.net ? ['--share-net'] : [])];
  for (const p of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) a.push('--ro-bind-try', p, p);
  a.push('--proc', '/proc', '--tmpfs', '/tmp');
  a.push(o.gui ? '--dev-bind' : '--dev', ...(o.gui ? ['/dev', '/dev'] : ['/dev']));
  if (o.gui) {
    a.push('--ro-bind-try', '/tmp/.X11-unix', '/tmp/.X11-unix', '--ro-bind-try', '/sys', '/sys');
    const xdg = process.env.XDG_RUNTIME_DIR;
    const wl = process.env.WAYLAND_DISPLAY;
    if (xdg && wl) a.push('--ro-bind-try', join(xdg, wl), join(xdg, wl));
    if (process.env.XAUTHORITY) a.push('--ro-bind-try', process.env.XAUTHORITY, process.env.XAUTHORITY);
  }
  for (const p of o.ro) a.push('--ro-bind', resolve(p), resolve(p));
  for (const p of o.rw) a.push('--bind', resolve(p), resolve(p));
  a.push('--clearenv');
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) a.push('--setenv', k, v);
  a.push('--chdir', resolve(o.rw[0] ?? '/'), bin, ...args);
  return { cmd: bwrap, args: a, sandboxed: true, env: {} };
}

async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

function runCapture(cmd: string, args: string[], timeout = 30000): Promise<string> {
  return new Promise((r) => execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (_e, out, err) => r(`${out}\n${err}`)));
}

export async function toolStatus(): Promise<ToolStatus[]> {
  const sandbox = findBwrap() ? 'bubblewrap' : 'none';
  const meta = async (id: ToolId): Promise<{ version?: string; mcp?: boolean }> => {
    try { return JSON.parse(await fsp.readFile(join(dirOf(id), 'meta.json'), 'utf8')); } catch { return {}; }
  };
  const [bl, bb] = await Promise.all([meta('blender'), meta('blockbench')]);
  return [
    { id: 'blender', installed: await exists(managedBlender()), version: bl.version, sandbox, size: await dirSize(dirOf('blender')) },
    { id: 'blockbench', installed: await exists(managedBlockbench()), version: bb.version, mcp: !!bb.mcp && (await exists(mcpPluginFile())), sandbox, size: await dirSize(dirOf('blockbench')) },
  ];
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    let entries: import('node:fs').Dirent[];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch { /* weg */ } }
    }
  };
  await walk(dir);
  return total;
}

export type ToolProgress = { id: ToolId; step: string; percent?: number; done?: boolean; error?: string };
type Emit = (p: ToolProgress) => void;

const active = new Map<ToolId, AbortController>();
export const cancelInstall = (id: ToolId) => { active.get(id)?.abort(); };

async function download(url: string, dest: string, signal: AbortSignal, onPercent: (p: number) => void): Promise<void> {
  const res = await fetch(url, { signal, headers: { 'User-Agent': 'Quorum' } });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let last = 0;
  const src = Readable.fromWeb(res.body as never);
  src.on('data', (c: Buffer) => {
    got += c.length;
    const now = Date.now();
    if (total && now - last > 250) { last = now; onPercent(Math.round((got / total) * 100)); }
  });
  await pipeline(src, createWriteStream(dest), { signal });
}

function exec(cmd: string, args: string[], cwd: string, signal: AbortSignal): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], signal });
    let err = '';
    p.stderr.on('data', (c) => { err = (err + c).slice(-800); });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(err.trim() || `${cmd} endete mit Code ${code}`))));
  });
}

async function latestBlender(): Promise<{ version: string; url: string }> {
  const index = await (await fetch('https://download.blender.org/release/')).text();
  const dirs = [...index.matchAll(/href="Blender(\d+\.\d+)\/"/g)].map((m) => m[1]).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const d of dirs.reverse()) {
    const page = await (await fetch(`https://download.blender.org/release/Blender${d}/`)).text();
    const files = [...new Set([...page.matchAll(/href="(blender-(\d+\.\d+\.\d+)-linux-x64\.tar\.xz)"/g)].map((m) => ({ name: m[1], v: m[2] })))]
      .sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
    const f = files.at(-1);
    if (f) return { version: f.v, url: `https://download.blender.org/release/Blender${d}/${f.name}` };
  }
  throw new Error('Keine Blender-Linux-Version gefunden');
}

async function installBlender(emit: Emit, signal: AbortSignal): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Die Sandbox-Installation unterstützt nur Linux.');
  emit({ id: 'blender', step: 'Version ermitteln …' });
  const { version, url } = await latestBlender();
  const dir = dirOf('blender');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const archive = join(dir, 'blender.tar.xz');
  await download(url, archive, signal, (percent) => emit({ id: 'blender', step: `Blender ${version} laden …`, percent }));
  emit({ id: 'blender', step: 'Entpacken …' });
  await exec('tar', ['-xJf', archive, '--strip-components=1'], dir, signal);
  await fsp.rm(archive, { force: true });
  if (!(await exists(managedBlender()))) throw new Error('Blender-Programm nach dem Entpacken nicht gefunden');
  await fsp.writeFile(join(dir, 'meta.json'), JSON.stringify({ version }));
}

/** Community-MCP-Plugin für Blockbench (jasonjgardner/blockbench-mcp-plugin) laden. */
async function installMcp(emit: Emit, signal: AbortSignal): Promise<void> {
  emit({ id: 'blockbench', step: 'MCP-Plugin laden …' });
  const rel = (await (await fetch(`https://api.github.com/repos/${MCP_REPO}/releases/latest`, { headers: { 'User-Agent': 'Quorum' } })).json()) as { assets?: { name: string; browser_download_url: string }[] };
  const asset = rel.assets?.find((a) => a.name === 'mcp.js');
  if (!asset) throw new Error('MCP-Plugin-Release nicht gefunden');
  await fsp.mkdir(join(dirOf('blockbench'), 'plugins'), { recursive: true });
  await download(asset.browser_download_url, mcpPluginFile(), signal, () => {});
}

async function installBlockbench(emit: Emit, signal: AbortSignal, withMcp: boolean): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Die Sandbox-Installation unterstützt nur Linux.');
  emit({ id: 'blockbench', step: 'Version ermitteln …' });
  const rel = (await (await fetch(`https://api.github.com/repos/${BLOCKBENCH_REPO}/releases/latest`, { headers: { 'User-Agent': 'Quorum' } })).json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  const asset = rel.assets.find((a) => a.name.endsWith('.AppImage'));
  if (!asset) throw new Error('Blockbench-AppImage nicht gefunden');
  const version = rel.tag_name.replace(/^v/, '');
  const dir = dirOf('blockbench');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const image = join(dir, 'Blockbench.AppImage');
  await download(asset.browser_download_url, image, signal, (percent) => emit({ id: 'blockbench', step: `Blockbench ${version} laden …`, percent }));
  await fsp.chmod(image, 0o755);
  emit({ id: 'blockbench', step: 'Entpacken …' });
  await exec(image, ['--appimage-extract'], dir, signal);
  await fsp.rename(join(dir, 'squashfs-root'), join(dir, 'app'));
  await fsp.rm(image, { force: true });
  if (withMcp) await installMcp(emit, signal);
  await fsp.writeFile(join(dir, 'meta.json'), JSON.stringify({ version, mcp: withMcp }));
}

/** Installiert ein Werkzeug (einzeln). Fortschritt und Ende kommen über `emit`. */
export async function installTool(id: ToolId, opts: { mcp?: boolean }, emit: Emit): Promise<void> {
  if (active.has(id)) throw new Error('Installation läuft bereits');
  const ctl = new AbortController();
  active.set(id, ctl);
  try {
    if (id === 'blender') await installBlender(emit, ctl.signal);
    else await installBlockbench(emit, ctl.signal, opts.mcp !== false);
    emit({ id, step: 'Fertig', done: true });
  } catch (e) {
    await fsp.rm(dirOf(id), { recursive: true, force: true }).catch(() => {});
    emit({ id, step: 'Fehler', done: true, error: ctl.signal.aborted ? 'Abgebrochen' : (e as Error).message });
  } finally {
    active.delete(id);
  }
}

/** Nur das MCP-Plugin nachinstallieren oder entfernen. */
export async function setMcp(enabled: boolean, emit: Emit): Promise<void> {
  const dir = dirOf('blockbench');
  if (!(await exists(managedBlockbench()))) throw new Error('Blockbench ist nicht installiert');
  if (enabled) await installMcp(emit, new AbortController().signal);
  else await fsp.rm(join(dir, 'plugins'), { recursive: true, force: true });
  let meta: { version?: string } = {};
  try { meta = JSON.parse(await fsp.readFile(join(dir, 'meta.json'), 'utf8')); } catch { /* neu */ }
  await fsp.writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, mcp: enabled }));
  emit({ id: 'blockbench', step: 'Fertig', done: true });
}

export async function uninstallTool(id: ToolId): Promise<void> {
  cancelInstall(id);
  await fsp.rm(dirOf(id), { recursive: true, force: true });
}

/** Blender-Version der Eigeninstallation (aus der Metadatei; schnell, ohne Prozessstart). */
export async function bundledVersion(id: ToolId): Promise<string | undefined> {
  try { return (JSON.parse(await fsp.readFile(join(dirOf(id), 'meta.json'), 'utf8')) as { version?: string }).version; } catch { return undefined; }
}

export { runCapture };
