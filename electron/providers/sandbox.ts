import { existsSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isWindowsShim, shimLaunch } from './win-shim';

export const SANDBOX_DIR = 'sandboxes';

/** Alles unter `<Daten>/sandboxes/<anbieter>/home` gehört zu einer Sandbox – allein der Pfad entscheidet, damit ein Start nie versehentlich ungeschützt läuft. */
const HOME_PATTERN = /^(.*[\\/]sandboxes[\\/][a-z]+[\\/]home)(?:[\\/]|$)/;
const PASSED_ENV = /^(LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TZ|NO_COLOR|FORCE_COLOR|PYTHONIOENCODING|PYTHONUTF8|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy)$/;
const SYSTEM_DIRS = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/etc', '/nix'];
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/bin:/bin';

export interface LaunchOptions {
  /** Arbeitsordner; in der Sandbox der einzige beschreibbare Ort neben dem Sandbox-Home. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Weitere beschreibbare Ordner (vom Nutzer ausdrücklich freigegeben). */
  share?: string[];
  /** Dateien oder Ordner, die nur lesbar eingeblendet werden (z. B. Anhänge). */
  expose?: string[];
  /** Interaktives Terminal: eigene Sitzung beibehalten und Farben erlauben. */
  tty?: boolean;
}

export interface Launch {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Windows: Argumente unverändert an cmd.exe durchreichen (`windowsVerbatimArguments`). */
  verbatim?: boolean;
}

export function sandboxHome(bin: string): string | undefined {
  return HOME_PATTERN.exec(bin)?.[1];
}

export function sandboxRoot(dataDir: string): string {
  return join(dataDir, SANDBOX_DIR);
}

export function sandboxPath(home: string): string {
  return [join(home, '.npm-global', 'bin'), join(home, '.local', 'bin'), SYSTEM_PATH].join(':');
}

function findBwrap(): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/usr/bin', '/bin', '/usr/local/bin'];
  return dirs.filter(Boolean).map((dir) => join(dir, 'bwrap')).find((candidate) => existsSync(candidate));
}

/** undefined = Sandbox verfügbar, sonst der Grund, warum nicht. */
export function sandboxUnavailable(): string | undefined {
  if (process.platform !== 'linux') {
    return 'Die Sandbox gibt es derzeit nur unter Linux.';
  }
  if (!findBwrap()) {
    return 'bubblewrap (bwrap) ist nicht installiert.';
  }
  return undefined;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Ein Ordner darf nur freigegeben werden, wenn er weder das Benutzerverzeichnis noch die App-Daten (und damit andere Sandboxes) enthält. */
export function canShare(home: string, dir: string): boolean {
  if (!dir || !existsSync(dir)) {
    return false;
  }
  const target = real(dir);
  const dataDir = real(dirname(dirname(dirname(home))));
  return !inside(real(homedir()), target) && !inside(dataDir, target) && !inside(target, join(dataDir, SANDBOX_DIR));
}

function sandboxEnv(home: string, source: NodeJS.ProcessEnv, tty: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && PASSED_ENV.test(key)) {
      env[key] = value;
    }
  }
  if (tty) {
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
  }
  const user = userInfo().username;
  return { ...env, HOME: home, USER: user, LOGNAME: user, PATH: sandboxPath(home), npm_config_prefix: join(home, '.npm-global'), npm_config_update_notifier: 'false' };
}

/**
 * Baut den bubblewrap-Aufruf: eigenes Dateisystem aus schreibgeschützten Systemordnern, das Sandbox-Home als $HOME und
 * nur die ausdrücklich freigegebenen Ordner. Das echte Benutzerverzeichnis und alle anderen Laufwerke existieren darin nicht.
 * Das Netzwerk bleibt offen, weil die CLIs ihre Anbieter-API erreichen müssen.
 */
export function bwrapCommand(home: string, argv: string[], options: LaunchOptions = {}): Launch {
  const reason = sandboxUnavailable();
  if (reason) {
    throw new Error(`Sandbox nicht verfügbar: ${reason}`);
  }
  if (!existsSync(home)) {
    throw new Error('Die Sandbox ist nicht installiert.');
  }
  const writable = [options.cwd, ...(options.share ?? [])].filter((dir): dir is string => !!dir && !inside(real(dir), real(home)));
  const blocked = writable.find((dir) => !canShare(home, dir));
  if (blocked) {
    throw new Error(`Sandbox: Der Ordner „${blocked}“ kann nicht freigegeben werden (fehlt oder umfasst das Benutzerverzeichnis bzw. die App-Daten). Wähle einen Projektordner.`);
  }
  const args = ['--unshare-all', '--share-net', '--die-with-parent', '--clearenv'];
  if (!options.tty) {
    args.push('--new-session');
  }
  for (const [key, value] of Object.entries(sandboxEnv(home, options.env ?? process.env, !!options.tty))) {
    args.push('--setenv', key, value);
  }
  args.push('--ro-bind', '/usr', '/usr');
  for (const dir of SYSTEM_DIRS) {
    args.push('--ro-bind-try', dir, dir);
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run');
  // /etc/resolv.conf zeigt oft nach /run (systemd-resolved); ohne das Ziel gäbe es in der Sandbox kein DNS.
  const resolv = real('/etc/resolv.conf');
  if (!inside(resolv, '/etc') && existsSync(resolv)) {
    args.push('--ro-bind', resolv, resolv);
  }
  for (const path of (options.expose ?? []).filter((entry) => entry && existsSync(entry))) {
    args.push('--ro-bind', path, path);
  }
  args.push('--bind', home, home);
  for (const dir of writable) {
    args.push('--bind', dir, dir);
  }
  args.push('--chdir', options.cwd ?? home, '--', ...argv);
  return { cmd: findBwrap()!, args, env: { PATH: process.env.PATH }, cwd: home };
}

/** Startbefehl einer CLI: liegt sie in einer Sandbox, läuft sie zwingend über bubblewrap – sonst unverändert. */
export function sandboxLaunch(bin: string, args: string[], options: LaunchOptions = {}): Launch {
  const home = sandboxHome(bin);
  if (!home && isWindowsShim(bin)) {
    return { ...shimLaunch(bin, args), env: options.env ?? process.env, cwd: options.cwd };
  }
  if (!home) {
    return { cmd: bin, args, env: options.env ?? process.env, cwd: options.cwd };
  }
  return bwrapCommand(home, [bin, ...args], options);
}

/** Befehl für ein interaktives Terminal; ein nicht freigebbarer Ordner (z. B. das Benutzerverzeichnis) wird dort einfach weggelassen. */
export function terminalCommand(bin: string, cwd: string): { bin: string; args: string[] } {
  const home = sandboxHome(bin);
  if (!home) {
    return { bin, args: [] };
  }
  const launch = bwrapCommand(home, [bin], { cwd: canShare(home, cwd) ? cwd : undefined, tty: true });
  return { bin: launch.cmd, args: launch.args };
}
