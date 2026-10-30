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
