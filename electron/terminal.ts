import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';

// Ein PTY ohne native Module: kleiner Python-Helfer (pty.fork) – läuft auf Linux/macOS.
// Fenster-Größe kommt über einen separaten Steuerkanal (fd 3). Unter Windows: Pipe-Modus (ohne echtes PTY).
const HELPER = `import os, pty, sys, select, struct, fcntl, termios, signal
shell, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
extra = sys.argv[4:]
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLORTERM'] = 'truecolor'
    os.execvp(shell, [shell] + extra)
def setsize(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
setsize(cols, rows)
buf = b''
try:
    while True:
        r, _, _ = select.select([fd, 0, 3], [], [])
        if fd in r:
            try: d = os.read(fd, 65536)
            except OSError: break
            if not d: break
            os.write(1, d)
        if 0 in r:
            d = os.read(0, 65536)
            if not d: break
            os.write(fd, d)
        if 3 in r:
            d = os.read(3, 1024)
            if d:
                buf += d
                while b'\\n' in buf:
                    line, buf = buf.split(b'\\n', 1)
                    try:
                        c, rr = line.split()
                        setsize(int(c), int(rr))
                    except Exception: pass
finally:
    try: os.kill(pid, signal.SIGHUP)
    except Exception: pass
    try: os.waitpid(pid, 0)
    except Exception: pass
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

export function createTerminal(wc: WebContents, id: string, cwd: string, cols: number, rows: number, dataDir: string, command?: { bin: string; args: string[] }): { mode: 'pty' | 'pipe' } {
  killTerminal(id);
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  let proc: ChildProcess;
  let mode: 'pty' | 'pipe' = 'pty';
  if (process.platform === 'win32') {
    mode = 'pipe';
    proc = spawn(process.env.COMSPEC && !process.env.PSModulePath ? process.env.COMSPEC : 'powershell.exe', process.env.PSModulePath ? ['-NoLogo', '-NoExit'] : [], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    mkdirSync(dataDir, { recursive: true });
    const helper = join(dataDir, 'pty-helper.py');
    writeFileSync(helper, HELPER);
    const shell = command?.bin ?? (process.env.SHELL || '/bin/bash');
    proc = spawn('python3', ['-u', helper, shell, String(cols), String(rows), ...(command ? command.args : ['-i'])], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { ...process.env } });
  }
  const out = (d: Buffer) => { if (!wc.isDestroyed()) wc.send('term:data', { id, data: d.toString('utf8') }); };
  proc.stdout?.on('data', out);
  proc.stderr?.on('data', out);
  proc.on('close', (code) => { terms.delete(id); if (!wc.isDestroyed()) wc.send('term:exit', { id, code }); });
  proc.on('error', (e) => { if (!wc.isDestroyed()) wc.send('term:data', { id, data: `\r\n[Terminal konnte nicht gestartet werden: ${e.message}]\r\n` }); });
  terms.set(id, { proc, wc });
  return { mode };
}

export const writeTerminal = (id: string, data: string) => { terms.get(id)?.proc.stdin?.write(data); };
export function resizeTerminal(id: string, cols: number, rows: number) {
  const ctl = terms.get(id)?.proc.stdio[3] as NodeJS.WritableStream | null | undefined;
  ctl?.write(`${cols} ${rows}\n`);
}
export function killTerminal(id: string) {
  const t = terms.get(id);
  if (!t) return;
  try { t.proc.kill('SIGTERM'); } catch { /* schon beendet */ }
  terms.delete(id);
}
export function killTerminalsOf(wc: WebContents) {
  for (const [id, t] of terms) if (t.wc === wc) killTerminal(id);
}
