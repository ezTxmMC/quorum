import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageReport, UsageTokens } from '../shared/types';

const DAYS = 14;
const day = (t: number | string) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const zero = (): UsageTokens => ({ input: 0, output: 0, cached: 0, sessions: 0 });

type FileInfo = { path: string; mtime: number; size: number };
function walk(dir: string, match: (n: string) => boolean, since: number, out: FileInfo[] = [], depth = 0): FileInfo[] {
  if (!existsSync(dir) || depth > 5) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, match, since, out, depth + 1);
    else if (match(e.name)) { try { const st = statSync(p); if (st.mtimeMs >= since) out.push({ path: p, mtime: st.mtimeMs, size: st.size }); } catch { /* weg */ } }
  }
  return out;
}

// Ergebnis je Datei zwischenspeichern: unveränderte Verläufe (gleiche Größe + mtime) werden nicht erneut gelesen.
type ClaudeMsg = { t: string; i: number; o: number; c: number };
type CodexFile = { last: ClaudeMsg | null; limits: UsageReport['codexLimits']; limitsAt: number };
const fileCache = new Map<string, { mtime: number; size: number; claude?: Map<string, ClaudeMsg>; codex?: CodexFile }>();
const fresh = (f: FileInfo) => { const c = fileCache.get(f.path); return c && c.mtime === f.mtime && c.size === f.size ? c : null; };

/** Liest Token-Nutzung und Codex-Limits direkt aus den lokalen CLI-Verlaufsdateien (auch für Sessions außerhalb des Hubs). Läuft im Worker-Thread. */
export async function scanUsage(): Promise<UsageReport> {
  const since = Date.now() - DAYS * 86400_000;
  const byDay: Record<string, { claude: UsageTokens; codex: UsageTokens }> = {};
  for (let i = 0; i < DAYS; i++) byDay[day(Date.now() - i * 86400_000)] = { claude: zero(), codex: zero() };
  let limits: UsageReport['codexLimits'] = null;
  let limitsAt = 0;

  // Claude Code: usage je Assistant-Nachricht (eine Nachricht kann über mehrere Zeilen verteilt sein -> je ID das Maximum)
  for (const f of walk(join(homedir(), '.claude', 'projects'), (n) => n.endsWith('.jsonl'), since)) {
    let msgs = fresh(f)?.claude;
    if (!msgs) {
    msgs = new Map<string, ClaudeMsg>();
    let content = '';
    try { content = await readFile(f.path, 'utf8'); } catch { continue; }
    for (const l of content.split('\n')) {
      if (!l.includes('"usage"')) continue;
      try {
        const d = JSON.parse(l);
        const u = d.message?.usage; const id = d.message?.id;
        if (!u || !id || d.type !== 'assistant') continue;
        const cur = msgs.get(id);
        const i = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), o = u.output_tokens ?? 0, c = u.cache_read_input_tokens ?? 0;
        if (!cur || o >= cur.o) msgs.set(id, { t: d.timestamp, i, o, c });
      } catch { /* defekte Zeile */ }
    }
    fileCache.set(f.path, { mtime: f.mtime, size: f.size, claude: msgs });
    }
    const touched = new Set<string>();
    for (const m of msgs.values()) {
      const b = byDay[day(m.t)]; if (!b) continue;
      b.claude.input += m.i; b.claude.output += m.o; b.claude.cached += m.c;
      touched.add(day(m.t));
    }
    for (const k of touched) byDay[k].claude.sessions++;
  }

  // Codex: Summe der letzten token_count je Session/Tag, plus aktuelle Rate-Limits
  for (const f of walk(join(homedir(), '.codex', 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), since)) {
    let info = fresh(f)?.codex;
    if (!info) {
    let last: ClaudeMsg | null = null;
    let fLimits: UsageReport['codexLimits'] = null;
    let fAt = 0;
    let content = '';
    try { content = await readFile(f.path, 'utf8'); } catch { continue; }
    for (const l of content.split('\n')) {
      if (!l.includes('token_count')) continue;
      try {
        const d = JSON.parse(l);
        const p = d.payload;
        if (d.type !== 'event_msg' || p?.type !== 'token_count') continue;
        const u = p.info?.total_token_usage;
        if (u) last = { t: d.timestamp, i: u.input_tokens ?? 0, o: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0), c: u.cached_input_tokens ?? 0 };
        const rl = p.rate_limits;
        const ts = Date.parse(d.timestamp);
        if (rl?.primary && ts > fAt) {
          fAt = ts;
          fLimits = { plan: rl.plan_type ?? null, primary: rl.primary, secondary: rl.secondary ?? null, credits: rl.credits ?? null, at: ts };
        }
      } catch { /* defekte Zeile */ }
    }
    info = { last, limits: fLimits, limitsAt: fAt };
    fileCache.set(f.path, { mtime: f.mtime, size: f.size, codex: info });
    }
    const last = info.last;
    if (info.limits && info.limitsAt > limitsAt) { limitsAt = info.limitsAt; limits = info.limits; }
    if (last) { const b = byDay[day(last.t)]; if (b) { b.codex.input += last.i; b.codex.output += last.o; b.codex.cached += last.c; b.codex.sessions++; } }
  }

  const days = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
  return { days, codexLimits: limits };
}
