import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS } from '../../shared/catalog';
import type { SandboxProvider, SandboxResult, SandboxStatus } from '../../shared/sandbox';
import type { ProviderId } from '../../shared/types';
import { execCli, resolveBinary } from './detect';
import { bwrapCommand, sandboxRoot, sandboxUnavailable } from './sandbox';

const INSTALL_TIMEOUT_MS = 15 * 60_000;

// Neuere npm-Versionen führen Installationsskripte nur für ausdrücklich erlaubte Pakete aus.
const npmInstall = (pkg: string) => `npm install --global --no-fund --no-audit --allow-scripts=${pkg} ${pkg}`;

/** Installationsweg je Anbieter. `null` = es gibt kein Paket; die bereits installierte CLI wird in die Sandbox kopiert. */
const RECIPES: Record<SandboxProvider, string | null> = {
  claude: npmInstall('@anthropic-ai/claude-code'),
  codex: npmInstall('@openai/codex'),
  opencode: npmInstall('opencode-ai'),
  kimi: 'python3 -m venv "$HOME/.venv" && "$HOME/.venv/bin/pip" install --upgrade kimi-cli && mkdir -p "$HOME/.local/bin" && ln -sf "$HOME/.venv/bin/kimi" "$HOME/.local/bin/kimi"',
  antigravity: null,
};

const installing = new Set<SandboxProvider>();

function homeOf(dataDir: string, provider: SandboxProvider): string {
  return join(sandboxRoot(dataDir), provider, 'home');
}

function binOf(home: string, provider: SandboxProvider): string | undefined {
  const name = PROVIDERS[provider].bin;
  return [join(home, '.npm-global', 'bin', name), join(home, '.local', 'bin', name)].find((candidate) => existsSync(candidate));
}

export async function sandboxStatus(dataDir: string, provider: SandboxProvider): Promise<SandboxStatus> {
  const home = homeOf(dataDir, provider);
  const reason = sandboxUnavailable();
  const bin = binOf(home, provider);
  if (reason || !bin) {
    return { provider, supported: !reason, reason, installed: !!bin, bin, home };
  }
  const result = await execCli(bin, ['--version'], undefined, 20_000);
  const version = (result.stdout || result.stderr).trim().split('\n')[0] || undefined;
  return { provider, supported: true, installed: true, bin, version, home };
}

function runScript(home: string, script: string, onLine: (text: string) => void): Promise<SandboxResult> {
  return new Promise((done) => {
    const launch = bwrapCommand(home, ['/bin/sh', '-c', script]);
    const child = spawn(launch.cmd, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      done(code === 0 ? { ok: true } : { ok: false, error: `Installation beendet mit Code ${code}` });
    });
  });
}

/** Für CLIs ohne Paketquelle: die vorhandene Programmdatei des Systems in die Sandbox kopieren. Konfiguration und Anmeldung bleiben getrennt. */
function copyHostBinary(home: string, provider: SandboxProvider, hostBinaries: Partial<Record<ProviderId, string>>): SandboxResult {
  const host = resolveBinary(provider, hostBinaries);
  if (!host) {
    return { ok: false, error: `${PROVIDERS[provider].name} ist auf dem System nicht installiert – ohne Vorlage kann die CLI nicht in die Sandbox kopiert werden.` };
  }
  const target = join(home, '.local', 'bin', PROVIDERS[provider].bin);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  copyFileSync(realpathSync(host), target);
  chmodSync(target, 0o755);
  return { ok: true };
}

/** Installiert oder aktualisiert die CLI im eigenen Sandbox-Home; die Installation selbst läuft bereits isoliert. */
export async function installSandbox(dataDir: string, provider: SandboxProvider, hostBinaries: Partial<Record<ProviderId, string>>, onLine: (text: string) => void): Promise<SandboxResult> {
  const reason = sandboxUnavailable();
  if (reason) {
    return { ok: false, error: reason };
  }
  if (installing.has(provider)) {
    return { ok: false, error: 'Die Installation läuft bereits.' };
  }
  installing.add(provider);
  try {
    const home = homeOf(dataDir, provider);
    mkdirSync(home, { recursive: true });
    const recipe = RECIPES[provider];
    const result = recipe ? await runScript(home, recipe, onLine) : copyHostBinary(home, provider, hostBinaries);
    if (result.ok && !binOf(home, provider)) {
      return { ok: false, error: `Die Installation lief durch, aber „${PROVIDERS[provider].bin}“ wurde nicht gefunden.` };
    }
    return result;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    installing.delete(provider);
  }
}

/** Löscht die Sandbox samt Anmeldung, Verlauf und Konfiguration dieser Variante. */
export function removeSandbox(dataDir: string, provider: SandboxProvider): SandboxResult {
  if (installing.has(provider)) {
    return { ok: false, error: 'Die Installation läuft noch.' };
  }
  rmSync(join(sandboxRoot(dataDir), provider), { recursive: true, force: true });
  return { ok: true };
}
