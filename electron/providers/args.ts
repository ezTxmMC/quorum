/**
 * Shell-artige Argumentzeile in Tokens zerlegen.
 * Leerraum trennt nur außerhalb von Anführungszeichen; '…' ist wörtlich, in "…" gelten nur \" und \\ als Escapes.
 * Anführungszeichen dürfen mitten im Token stehen (--flag="a b") und werden entfernt; "" ergibt ein leeres Argument.
 */
export function splitArgs(s: string | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  let cur = '';
  let started = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) { out.push(cur); cur = ''; started = false; } }
    else { cur += ch; started = true; }
  }
  if (started) out.push(cur);
  return out;
}

/** Tool-Regeln (`Bash(git *) Edit, Read`): Trenner (Komma/Leerraum) gelten nur außerhalb von Klammern. */
export function splitRules(s: string | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  const flush = () => {
    let t = cur.trim();
    if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0])) t = t.slice(1, -1);
    if (t) out.push(t);
    cur = '';
  };
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) flush(); else cur += ch;
  }
  flush();
  return out;
}

/**
 * Prompt als einzelnes Kommandozeilen-Argument auf die Grenze des Betriebssystems kürzen.
 * Windows erlaubt rund 32 000 Zeichen für die ganze Befehlszeile, Linux 131 072 Bytes je Argument – gemessen wird deshalb in Bytes.
 * Anweisungen und Bildverweise (lead) bleiben erhalten; gekürzt wird der Anfang des Verlaufs, das Ende mit der aktuellen Frage bleibt.
 */
export function fitPromptArgument(instructions: string, lead: string, body: string, platform: string = process.platform): string {
  const limit = platform === 'win32' ? 28_000 : 120_000;
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
  const head = clipEnd(instructions, Math.floor(limit / 2), bytes) + lead;
  const room = Math.max(0, limit - bytes(head));
  let tail = room ? body.slice(-room) : '';
  while (bytes(tail) > room) {
    tail = tail.slice(Math.max(1, Math.ceil((bytes(tail) - room) / 3)));
  }
  // Ein halbes Zeichenpaar am Schnitt ergäbe ein ungültiges Zeichen.
  if (/^[\uDC00-\uDFFF]/.test(tail)) {
    tail = tail.slice(1);
  }
  return head + tail;
}

function clipEnd(text: string, limit: number, bytes: (text: string) => number): string {
  let kept = text;
  while (bytes(kept) > limit) {
    kept = kept.slice(0, kept.length - Math.max(1, Math.ceil((bytes(kept) - limit) / 3)));
  }
  return kept;
}
