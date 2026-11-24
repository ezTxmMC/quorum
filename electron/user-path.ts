import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const SHELL_TIMEOUT_MS = 4000;

function shellPath(): string {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const output = execFileSync(shell, ['-ilc', 'printf "\\n__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: SHELL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    return /__PATH__(.*)__PATH__/.exec(output)?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * macOS startet Programme aus Finder und Dock mit einem Minimal-PATH ohne Homebrew, npm oder ~/.local/bin.
 * Ohne den PATH der Login-Shell fände die App weder die CLIs noch `node` für deren Start-Skripte.
 */
export function adoptUserPath(): void {
  if (process.platform !== 'darwin') {
    return;
  }
  const common = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', join(homedir(), '.local', 'bin')];
  const entries = [...(process.env.PATH ?? '').split(delimiter), ...shellPath().split(delimiter), ...common];
  process.env.PATH = [...new Set(entries.filter(Boolean))].join(delimiter);
}
