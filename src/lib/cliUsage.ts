import { Terminal } from '@xterm/xterm';
import type { CliUsage, UsageMeter } from '@shared/types';
import { hub, uid } from './api';

/** Liest Prozentwerte (mit Beschriftung, Gruppe und Reset-Hinweis) aus dem Bildschirmtext der /usage-Ansicht. */
export function parseMeters(screen: string): UsageMeter[] {
  // Balken ([████░░]) und Rahmenzeichen entfernen, damit nur Beschriftungen und Zahlen übrig bleiben.
  const lines = screen.split('\n').map((l) => l.replace(/[█▌▍▎▏▉▊▋░▒▓■□●○◔◑◕◐◒◓│┃┆╎╭╮╰╯─\[\]]/g, ' ').replace(/\s+/g, ' ').trim());
  const isReset = (l: string) => /\b(res[ie]ts?|refreshes?)\b|quota available|zurückgesetzt/i.test(l);
  const hasPct = (l: string) => /\d\s*%/.test(l);
  // Überschriften der Gruppen stehen in GROSSBUCHSTABEN (z. B. "GEMINI MODELS", "CLAUDE AND GPT MODELS").
  const isHeading = (l: string) => l.length > 2 && l.length < 40 && l === l.toUpperCase() && /[A-ZÄÖÜ]{3}/.test(l) && !hasPct(l);
  const out: UsageMeter[] = [];
  const seen = new Set<string>();
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = /(\d{1,3}(?:[.,]\d+)?)\s*%/.exec(line);
    if (!m) {
      if (isHeading(line)) heading = line.replace(/\b\w/g, (c) => c).replace(/(\w)(\w*)/g, (_, a: string, b: string) => a + b.toLowerCase());
      continue;
    }
    const percent = Math.min(100, parseFloat(m[1].replace(',', '.')));
    let label = line.slice(0, m.index).replace(/[:\-–—·]+\s*$/, '').trim();
    let labelIdx = i;
    if (!label || /^(used|remaining|left)\b/i.test(label)) {
      label = '';
      for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
        if (lines[j] && !hasPct(lines[j]) && !isReset(lines[j])) { label = lines[j]; labelIdx = j; break; }
      }
    }
    let reset: string | undefined;
    for (let j = labelIdx; j <= Math.min(lines.length - 1, i + 2); j++) {
      const r = /((?:res[ie]ts?|refreshes?)\b[^%]*|quota available)/i.exec(lines[j]);
      if (r) { reset = r[1].replace(/\s*\d+\s*%.*$/, '').trim(); break; }
    }
    const rest = line.slice(m.index + m[0].length);
    const kind: UsageMeter['kind'] = /remaining|left|verbleib/i.test(label + ' ' + rest) ? 'remaining' : 'used';
    const key = `${heading}|${label}|${percent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label || '–', percent, reset, group: heading || undefined, kind });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fragt `/usage` ab, ohne dass der Nutzer etwas tun muss: Die CLI läuft unsichtbar in einem PTY (Hauptprozess),
 * ihre Ausgabe wird in ein nicht angezeigtes xterm gespeist, dessen Bildschirmtext anschließend ausgewertet wird.
 */
export async function queryCliUsage(provider: 'claude' | 'antigravity', cwd: string): Promise<CliUsage> {
  const id = uid();
  const term = new Terminal({ cols: 120, rows: 45, allowProposedApi: true, scrollback: 0 });
  const off = hub.onTermData((p) => { if (p.id === id) term.write(p.data); });
  const screen = () => {
    const b = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  };
  const fail = (error: string, raw = ''): CliUsage => ({ provider, ok: false, meters: [], raw, error, at: Date.now() });

  try {
    const r = await hub.termCreate(id, cwd, 120, 45, provider);
    if (r.mode === 'missing') return fail('CLI nicht gefunden');
    if (hub.platform === 'win32') return fail('Unter Windows nicht unterstützt (kein PTY).');

    // 1. Warten, bis die CLI gestartet und bereit für Eingaben ist.
    // Eventuelle Bestätigungsdialoge (z. B. Workspace-Trust bei Claude) automatisch annehmen.
    const start = Date.now();
    while (Date.now() - start < 15000) {
      await sleep(150);
      const text = screen();
      // Claude Workspace-Trust Prompt:
      if (/trust this folder|safety check|❯\s*No,\s*exit/i.test(text)) {
        // Pfeil nach unten ("Yes, I trust this folder"), dann Enter
        await hub.termWrite(id, '\x1b[B\r');
        await sleep(500);
        continue;
      }
      // Popup / Ankündigung ("Press Enter to continue"):
      if (/press enter to continue/i.test(text)) {
        await hub.termWrite(id, '\r');
        await sleep(300);
        continue;
      }
      // CLI-Prompt bereit:
      if (/[❯>]/.test(text) || /shortcuts/i.test(text) || /Try\s*"/i.test(text) || /Models & Quota/i.test(text)) {
        break;
      }
    }

    await sleep(300);

    // 2. Beide CLIs kennen /usage. Escape davor schließt evtl. offene Popups.
    const steps: string[][] = provider === 'claude'
      ? [['\x1b', '/usage\r']]
      : [['\x1b', '/usage\r'], ['\x1b', '/status\r']];

    for (const step of steps) {
      for (const keys of step) {
        await hub.termWrite(id, keys);
        await sleep(250);
      }

      // Warten auf das Erscheinen der Prozentwerte (bis zu 8s)
      const queryStart = Date.now();
      let meters: UsageMeter[] = [];
      let text = '';
      while (Date.now() - queryStart < 8000) {
        await sleep(200);
        text = screen();
        meters = parseMeters(text);
        if (meters.length > 0) break;
      }

      if (meters.length > 0) {
        // Scrollbare Ansicht weiterblättern (z. B. "(1–11 of 37 lines)" bei Antigravity)
        const seen = new Set(meters.map((m) => `${m.group}|${m.label}|${m.percent}`));
        for (let page = 0; page < 8; page++) {
          const ind = /\((\d+)\s*[–-]\s*(\d+)\s+of\s+(\d+)\s+lines?\)/i.exec(text);
          if (!ind || Number(ind[2]) >= Number(ind[3])) break;
          await hub.termWrite(id, '\x1b[6~'); // PageDown
          await sleep(400);
          text = screen();
          for (const m of parseMeters(text)) {
            const k = `${m.group}|${m.label}|${m.percent}`;
            if (!seen.has(k)) {
              seen.add(k);
              meters.push(m);
            }
          }
        }
        return {
          provider,
          ok: true,
          meters,
          raw: text.split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n'),
          at: Date.now(),
        };
      }
    }

    const text = screen();
    return fail('Keine Prozentwerte in der Ausgabe gefunden.', text.split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n'));
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    off();
    void hub.termKill(id);
    term.dispose();
  }
}
