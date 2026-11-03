// Kommandozeile von Quorum: gemeinsam genutzt vom Hauptprozess (GUI), vom Node-Launcher und von der TUI. Keine Electron-Abhängigkeit.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface CliArgs {
  help: boolean;
  version: boolean;
  /** Terminal-Oberfläche statt Fenster. */
  tui: boolean;
  /** Ohne Fenster im Tray starten. */
  tray: boolean;
  /** Einmalige Anfrage ohne Oberfläche (`-p "…"`); '-' = Prompt von stdin. */
  print?: string;
  newWindow: boolean;
  reuseWindow: boolean;
  /** Absoluter Projektordner (Positionsargument oder -C). */
  folder?: string;
  provider?: string;
  model?: string;
  permission?: string;
  continueLast: boolean;
  json: boolean;
  /** Übrige Positionsargumente (bei -p: Teil des Prompts). */
  rest: string[];
  /** Nicht erkannte Optionen (Hinweis statt stiller Ignoranz). */
  unknown: string[];
  errors: string[];
}

/** `~` und relative Pfade gegen das Arbeitsverzeichnis des aufrufenden Prozesses auflösen. */
export function resolvePath(p: string, cwd: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p.startsWith('file://')) { try { return decodeURIComponent(new URL(p).pathname); } catch { /* unverändert */ } }
  return resolve(cwd, p);
}

const VALUE_FLAGS: Record<string, 'folder' | 'provider' | 'model' | 'permission'> = {
  '-C': 'folder', '--cwd': 'folder', '--folder': 'folder',
  '-P': 'provider', '--provider': 'provider',
  '-m': 'model', '--model': 'model',
  '--permission': 'permission',
};

/** Schalter, die Chromium/Electron selbst auswerten – sie sind kein Fehler. */
const CHROMIUM = /^--(no-sandbox|disable-|enable-|ozone-|inspect|remote-debugging|user-data-dir|app-path|js-flags|force-|use-|password-store|gtk-version|class|name|lang|proxy|ignore-|allow-|trace|v8-|wayland|disk-cache|log-|auth-|headless|unity-|no-)/;

/**
 * Wertet die Argumente aus. `argv` ist die Liste OHNE Programmnamen (bei `electron .` ohne den App-Pfad).
 */
export function parseArgs(argv: string[], cwd: string): CliArgs {
  const a: CliArgs = { help: false, version: false, tui: false, tray: false, newWindow: false, reuseWindow: false, continueLast: false, json: false, rest: [], unknown: [], errors: [] };
  const positional: string[] = [];
  const need = (i: number, flag: string): string | undefined => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('-') && v !== '-')) { a.errors.push(`${flag} needs a value`); return undefined; }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { positional.push(arg); continue; }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string | undefined => { if (inline !== undefined) return inline; const v = need(i, flag); if (v !== undefined) i++; return v; };
    switch (flag) {
      case '-h': case '--help': a.help = true; break;
      case '-v': case '--version': a.version = true; break;
      case '--tui': case '-t': a.tui = true; break;
      case '--tray': a.tray = true; break;
      case '-n': case '--new-window': a.newWindow = true; break;
      case '-r': case '--reuse-window': a.reuseWindow = true; break;
      case '--json': a.json = true; break;
      case '-c': case '--continue': a.continueLast = true; break;
      case '-p': case '--print': { const v = value(); if (v !== undefined) a.print = v; break; }
      default: {
        const key = VALUE_FLAGS[flag];
        if (key) { const v = value(); if (v !== undefined) a[key] = v; }
        else if (!CHROMIUM.test(arg)) a.unknown.push(arg);
      }
    }
  }
  if (a.folder) a.folder = resolvePath(a.folder, cwd);
  else if (positional.length) {
    const full = resolvePath(positional[0], cwd);
    // Eine Datei öffnet ihren Ordner.
    if (existsSync(full)) { a.folder = statSync(full).isDirectory() ? full : dirname(full); positional.shift(); }
  }
  if (a.folder && (!existsSync(a.folder) || !statSync(a.folder).isDirectory())) { a.errors.push(`Folder not found: ${a.folder}`); a.folder = undefined; }
  a.rest = positional;
  if (positional.length && a.print === undefined) a.errors.push(`Path not found: ${resolvePath(positional[0], cwd)}`);
  return a;
}

/** Soll dieser Aufruf ohne Fenster in Node laufen (TUI / Einmal-Antwort)? */
export const isTerminalMode = (a: CliArgs) => a.tui || a.print !== undefined;

export const HELP = `Quorum – all models, one table

Usage:
  quorum [folder]              Open Quorum with a new chat in the folder (a file opens its folder)
  quorum plan --help           Persistent workspace plans (JSON CLI)
  quorum --tray                Start hidden in the system tray
  quorum --tui [folder]        Terminal UI right in your shell
  quorum -p "prompt" [folder]  One-shot answer on stdout ("-p -" reads the prompt from stdin)

Options:
  -C, --cwd <dir>              Project folder (alternative to the positional folder)
  -P, --provider <id>          claude | codex | antigravity | opencode | ollama | local | api
  -m, --model <id>             Model id
      --permission <mode>      Provider permission mode (see the in-app mode names)
  -c, --continue               TUI: continue the latest chat of the folder
  -n, --new-window             Open a new window even if Quorum is already running
  -r, --reuse-window           Open the folder in the existing window
      --json                   With -p: print events as JSON lines
  -h, --help                   Show this help
  -v, --version                Show the version

Examples:
  quorum .                     Open the current directory
  quorum --tray                Autostart-friendly: tray icon only
  git diff | quorum -p - "Review this diff" -P codex
`;
