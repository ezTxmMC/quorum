import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import type { WebContents } from 'electron';

// Ein PTY ohne native Module: kleiner Python-Helfer (pty.fork) – läuft auf Linux/macOS.
// Fenster-Größe kommt über einen separaten Steuerkanal (fd 3). Unter Windows: Pipe-Modus (ohne echtes PTY).
const HELPER = `import os, pty, sys, select, struct, fcntl, termios, signal
shell, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
extra = sys.argv[4:]
pid, fd = pty.fork()
if pid == 0:
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGHUP, signal.SIG_DFL)
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLORTERM'] = 'truecolor'
    os.execvp(shell, [shell] + extra)
def setsize(c, r):
    try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except Exception: pass
setsize(cols, rows)
try:
    attrs = termios.tcgetattr(fd)
    attrs[0] |= getattr(termios, 'IUTF8', 0)
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
except Exception: pass
def _stop(*_a): raise SystemExit
signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGHUP, _stop)
buf = b''
poller = select.poll()
poller.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
poller.register(0, select.POLLIN | select.POLLHUP | select.POLLERR)
try: poller.register(3, select.POLLIN | select.POLLHUP | select.POLLERR)
except Exception: pass
try:
    while True:
        events = poller.poll()
        for ev_fd, ev in events:
            if ev_fd == fd:
                if ev & (select.POLLIN | select.POLLHUP | select.POLLERR):
                    try: d = os.read(fd, 65536)
                    except OSError: d = b''
                    if not d: raise StopIteration
                    os.write(1, d)
            elif ev_fd == 0:
                if ev & select.POLLIN:
                    try: d = os.read(0, 65536)
                    except OSError: d = b''
                    if not d: raise StopIteration
                    try: os.write(fd, d)
                    except OSError: raise StopIteration
                elif ev & (select.POLLHUP | select.POLLERR):
                    raise StopIteration
            elif ev_fd == 3:
                if ev & select.POLLIN:
                    try: d = os.read(3, 1024)
                    except OSError: d = b''
                    if d:
                        buf += d
                        while b'\\n' in buf:
                            line, buf = buf.split(b'\\n', 1)
                            try:
                                c, rr = line.split()
                                setsize(int(c), int(rr))
                            except Exception: pass
                elif ev & (select.POLLHUP | select.POLLERR):
                    try: poller.unregister(3)
                    except Exception: pass
except (StopIteration, KeyboardInterrupt, SystemExit): pass
finally:
    import time
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    def _alive():
        try: return os.waitpid(pid, os.WNOHANG) == (0, 0)
        except Exception: return False
    for sig, wait in ((signal.SIGHUP, 0.6), (signal.SIGTERM, 0.6), (signal.SIGKILL, 0)):
        try: os.killpg(pid, sig)
        except Exception:
            try: os.kill(pid, sig)
            except Exception: pass
        end = time.time() + wait
        while _alive() and time.time() < end: time.sleep(0.03)
        if not _alive(): break
`;

/** Schreibt den PTY-Helfer ins Datenverzeichnis und gibt den Pfad zurück (auch für headless Abfragen genutzt). */
export function ensurePtyHelper(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const helper = join(dataDir, 'pty-helper.py');
  writeFileSync(helper, HELPER);
  return helper;
}

interface Term { proc: ChildProcess; wc: WebContents }
const terms = new Map<string, Term>();

export interface ShellInfo { id: string; name: string; path: string }

const NAMES: Record<string, string> = { bash: 'Bash', zsh: 'Zsh', fish: 'Fish', sh: 'sh', dash: 'Dash', ksh: 'Ksh', tcsh: 'tcsh', csh: 'csh', nu: 'Nushell', pwsh: 'PowerShell', xonsh: 'Xonsh', elvish: 'Elvish', powershell: 'Windows PowerShell', cmd: 'Eingabeaufforderung', wsl: 'WSL' };
const shellName = (path: string) => { const b = basename(path).replace(/\.exe$/i, '').toLowerCase(); return NAMES[b] ?? b; };

function onPath(bin: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) { const p = join(dir, bin + ext); if (dir && existsSync(p)) return p; }
  }
  return undefined;
}

let shellCache: ShellInfo[] | null = null;
/** Alle installierten Shells (aus /etc/shells und bekannte Kandidaten im PATH; unter Windows PowerShell, cmd, WSL, Git Bash). Die Login-Shell steht vorn. */
export function listShells(): ShellInfo[] {
  if (shellCache) return shellCache;
  const found: string[] = [];
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const git = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    for (const p of [onPath('pwsh'), join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), process.env.COMSPEC, onPath('wsl'), git]) if (p && existsSync(p)) found.push(p);
  } else {
    if (process.env.SHELL && existsSync(process.env.SHELL)) found.push(process.env.SHELL);
    try {
      for (const line of readFileSync('/etc/shells', 'utf8').split('\n')) {
        const l = line.trim();
        if (l.startsWith('/') && !/nologin|false|git-shell/.test(l) && existsSync(l)) found.push(l);
      }
    } catch { /* keine /etc/shells */ }
    for (const b of ['bash', 'zsh', 'fish', 'nu', 'pwsh', 'xonsh', 'elvish', 'dash', 'ksh', 'tcsh', 'sh']) { const p = onPath(b); if (p) found.push(p); }
  }
  const seen = new Set<string>();
  const out: ShellInfo[] = [];
  for (const path of found) {
    // Gleiche Shell in /bin und /usr/bin (Symlinks) nur einmal listen.
    const key = process.platform === 'win32' ? path.toLowerCase() : shellName(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: path, name: shellName(path), path });
  }
  shellCache = out;
  return out;
}

const utf8Env = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const loc = `${env.LC_ALL ?? ''}${env.LC_CTYPE ?? ''}${env.LANG ?? ''}`;
  if (!/utf-?8/i.test(loc)) { delete env.LC_ALL; delete env.LC_CTYPE; env.LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'; }
  return env;
};

function winShellArgs(shell: string): string[] {
  const n = shellName(shell);
  if (n === 'cmd') return ['/K', 'chcp 65001>nul'];
  if (n === 'pwsh' || n === 'powershell') return ['-NoLogo', '-NoExit', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::InputEncoding=[Text.Encoding]::UTF8'];
  if (n === 'bash' || n === 'sh') return ['-i'];
  return [];
}

export function createTerminal(wc: WebContents, id: string, cwd: string, cols: number, rows: number, dataDir: string, command?: { bin: string; args: string[] }, shellPath?: string): { mode: 'pty' | 'pipe' } {
  killTerminal(id);
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  const shell = command?.bin ?? (shellPath && existsSync(shellPath) ? shellPath : listShells()[0]?.path ?? process.env.SHELL ?? '/bin/bash');
  let proc: ChildProcess;
  let mode: 'pty' | 'pipe' = 'pty';
  if (process.platform === 'win32') {
    mode = 'pipe';
    const sh = shellPath ?? listShells()[0]?.path ?? 'powershell.exe';
    proc = spawn(sh, winShellArgs(sh), { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: utf8Env() });
  } else {
    mkdirSync(dataDir, { recursive: true });
    const helper = join(dataDir, 'pty-helper.py');
    writeFileSync(helper, HELPER);
    // Interaktive Shell; fish/nu/pwsh brauchen kein -i, vertragen es aber ebenfalls.
    proc = spawn('python3', ['-u', helper, shell, String(cols), String(rows), ...(command ? command.args : ['-i'])], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: utf8Env() });
  }
  // Mehrbyte-Zeichen können an Chunk-Grenzen zerschnitten werden – StringDecoder hält Reste bis zum nächsten Chunk zurück.
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  const out = (n: number) => (d: Buffer) => { const s = decoders[n].write(d); if (s && !wc.isDestroyed()) wc.send('term:data', { id, data: s }); };
  proc.stdout?.on('data', out(0));
  proc.stderr?.on('data', out(1));
  proc.on('close', (code) => {
    if (terms.get(id)?.proc === proc) terms.delete(id);
    if (!wc.isDestroyed()) wc.send('term:exit', { id, code });
  });
  proc.on('error', (e) => { if (!wc.isDestroyed()) wc.send('term:data', { id, data: `\r\n[Terminal konnte nicht gestartet werden: ${e.message}]\r\n` }); });
  proc.stdin?.on('error', () => { /* Prozess schon beendet */ });
  terms.set(id, { proc, wc });
  return { mode };
}

export const writeTerminal = (id: string, data: string) => { terms.get(id)?.proc.stdin?.write(data); };
export function resizeTerminal(id: string, cols: number, rows: number) {
  const ctl = terms.get(id)?.proc.stdio[3] as NodeJS.WritableStream | null | undefined;
  ctl?.on?.('error', () => {});
  try { ctl?.write(`${cols} ${rows}\n`); } catch { /* beendet */ }
}
export function killTerminal(id: string) {
  const t = terms.get(id);
  if (!t) return;
  terms.delete(id);
  const { proc } = t;
  // Erst EOF (der Helfer beendet dann die Shell samt Prozessgruppe), dann SIGTERM, zuletzt SIGKILL.
  try { proc.stdin?.end(); } catch { /* schon zu */ }
  try { proc.kill('SIGTERM'); } catch { /* schon beendet */ }
  const timer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill('SIGKILL'); } catch { /* weg */ } } }, 2500);
  timer.unref();
}
export function killTerminalsOf(wc: WebContents) {
  for (const [id, t] of terms) if (t.wc === wc) killTerminal(id);
}
export function killAllTerminals() {
  for (const id of [...terms.keys()]) killTerminal(id);
}
