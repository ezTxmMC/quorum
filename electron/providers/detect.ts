import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PROVIDERS, CLAUDE_MODELS } from '../../shared/catalog';
import { ollamaStatus } from './ollama';
import { listModels } from '../models/registry';
import { resolveRuntime } from '../runtimes/scheduler';
import type { CliCommandResult, ModelInfo, ProviderId, ProviderStatus } from '../../shared/types';

const EXTRA_DIRS = [join(homedir(), '.opencode', 'bin'), join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];

export function resolveBinary(id: ProviderId, overrides: Partial<Record<ProviderId, string>> = {}): string | undefined {
  if (id === 'ollama') return undefined; // laufen über HTTP-APIs, keine CLI
  const custom = overrides[id];
  if (custom && existsSync(custom)) return custom;
  const name = PROVIDERS[id].bin + (process.platform === 'win32' ? '.cmd' : '');
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_DIRS];
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function execCli(bin: string, args: string[], cwd?: string, timeout = 60000): Promise<CliCommandResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
      resolve({ ok: !err, code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function codexModels(bin: string): Promise<ModelInfo[]> {
  const r = await execCli(bin, ['debug', 'models'], undefined, 30000);
  try {
    const data = JSON.parse(r.stdout) as { models: { slug: string; display_name?: string; visibility?: string; supported_reasoning_levels?: { effort: string }[]; service_tiers?: { id: string; name: string; description: string }[] }[] };
    return data.models
      .filter((m) => m.visibility !== 'hidden' && m.visibility !== 'none')
      .map((m) => ({ id: m.slug, label: m.display_name ?? m.slug, efforts: m.supported_reasoning_levels?.map((l) => l.effort), speedTiers: m.service_tiers }));
  } catch { return []; }
}

async function agyModels(bin: string): Promise<ModelInfo[]> {
  const r = await execCli(bin, ['models'], undefined, 40000);
  // Zeilen wie "gemini-4-argon-high<TAB>Gemini 4 Argon (High)": Effort steckt in der ID -> zu einem Modell gruppieren.
  const groups = new Map<string, ModelInfo>();
  for (const l of r.stdout.split('\n')) {
    if (!l.includes('\t')) continue;
    const [id, label] = l.trim().split('\t');
    const m = /^(.*)-(low|medium|high)$/.exec(id);
    const lm = /^(.*) \((Low|Medium|High)\)$/.exec(label);
    if (!m || !lm) { groups.set(id, { id, label }); continue; }
    const g = groups.get(m[1]) ?? { id: m[1], label: lm[1], efforts: [] };
    g.efforts = [...(g.efforts ?? []), m[2]];
    groups.set(m[1], g);
  }
  return [...groups.values()];
}

/** `opencode models` listet "anbieter/modell" je Zeile. */
async function opencodeModels(bin: string): Promise<ModelInfo[]> {
  const r = await execCli(bin, ['models'], undefined, 40000);
  return r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)).map((id) => ({ id, label: id }));
}

const cache = new Map<ProviderId, ProviderStatus>();

/** Lokale Modelle: alle Registry-Einträge mit Text-Fähigkeit, die eine Runtime laden kann. Ohne Cache (ändert sich laufend). */
function localStatus(): ProviderStatus {
  const models = listModels()
    .filter((m) => m.capabilities.some((c) => ['chat', 'coding', 'reasoning', 'agent', 'vision'].includes(c)))
    .filter((m) => { try { resolveRuntime(m); return true; } catch { return false; } })
    .map((m) => ({ id: m.id, label: m.name }));
  return { id: 'local', installed: models.length > 0, models };
}

export async function providerStatus(id: ProviderId, overrides: Partial<Record<ProviderId, string>>, refresh = false): Promise<ProviderStatus> {
  if (id === 'ollama') {
    const s = await ollamaStatus();
    return { id, installed: s.up, version: s.up ? `Ollama ${s.version ?? ''}`.trim() : undefined, models: s.models };
  }
  if (id === 'local') return localStatus();
  const hit = cache.get(id);
  if (hit && !refresh) return hit;
  const bin = resolveBinary(id, overrides);
  if (!bin) return { id, installed: false, models: id === 'claude' ? CLAUDE_MODELS : [] };
  const v = await execCli(bin, ['--version'], undefined, 15000);
  const version = (v.stdout || v.stderr).trim().split('\n')[0];
  let models: ModelInfo[] = [];
  if (id === 'claude') models = CLAUDE_MODELS;
  else if (id === 'codex') models = await codexModels(bin);
  else if (id === 'opencode') models = await opencodeModels(bin);
  else models = await agyModels(bin);
  const status: ProviderStatus = { id, installed: true, path: bin, version, models };
  cache.set(id, status);
  return status;
}
