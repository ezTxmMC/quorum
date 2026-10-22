import type { ProviderId } from './types';

/** Listenpreise in USD je 1 Mio. Token (Eingabe / Ausgabe / Cache-Lesen). Nur Näherungswerte für die „theoretischen API-Kosten“ von Abo-/CLI-Nutzung. */
export interface Price { in: number; out: number; cache: number }

const p = (i: number, o: number, c = i / 10): Price => ({ in: i, out: o, cache: c });

/** Erste passende Zeile gewinnt – spezifischere Muster stehen oben. */
const TABLE: [RegExp, Price][] = [
  [/fable/i, p(10, 50, 1)],
  [/opus-?(4-?[0-4]|4\.[0-4]|3)\b|claude-3-opus/i, p(15, 75, 1.5)],
  [/opus/i, p(5, 25, 0.5)],
  [/sonnet/i, p(3, 15, 0.3)],
  [/haiku-?(3-?5|3\.5)/i, p(0.8, 4, 0.08)],
  [/haiku/i, p(1, 5, 0.1)],
  [/gpt-?5(\.\d+)?-?nano|gpt-?4\.1-?nano/i, p(0.05, 0.4, 0.005)],
  [/gpt-?5(\.\d+)?-?mini|gpt-?4\.1-?mini|codex-?mini/i, p(0.25, 2, 0.025)],
  [/gpt-?5\.[2-9]/i, p(1.75, 14, 0.175)],
  [/gpt-?5|codex/i, p(1.25, 10, 0.125)],
  [/o4-?mini/i, p(1.1, 4.4, 0.275)],
  [/\bo3\b/i, p(2, 8, 0.5)],
  [/gpt-?4\.1/i, p(2, 8, 0.5)],
  [/gpt-?4o/i, p(2.5, 10, 1.25)],
  [/gemini.*flash-?lite/i, p(0.1, 0.4, 0.01)],
  [/gemini.*flash/i, p(0.3, 2.5, 0.03)],
  [/gemini-?3.*pro/i, p(2, 12, 0.2)],
  [/gemini.*pro|gemini/i, p(1.25, 10, 0.125)],
];

/** Wenn das Modell unbekannt ist, rechnet der Hub mit dem Standardmodell des Anbieters. */
const PROVIDER_DEFAULT: Partial<Record<ProviderId, string>> = { claude: 'sonnet', codex: 'gpt-5', antigravity: 'gemini-pro' };
const FREE: ProviderId[] = ['ollama', 'local'];

export interface TokenUsage { inputTokens?: number; outputTokens?: number; cachedTokens?: number; costUsd?: number }
export interface Cost { usd: number; /** true = aus Token und Listenpreis geschätzt, false = vom Anbieter gemeldet */ estimated: boolean }

export function priceFor(model: string | undefined, provider: ProviderId | undefined): Price | undefined {
  for (const key of [model, provider ? PROVIDER_DEFAULT[provider] : undefined]) {
    if (!key) continue;
    const hit = TABLE.find(([re]) => re.test(key));
    if (hit) return hit[1];
  }
  return undefined;
}

/** Kosten, die dieselbe Nutzung über die API kosten würde. Meldet die CLI Kosten selbst (Claude), werden diese übernommen. Lokale Modelle sind kostenlos (undefined). */
export function apiCost(u: TokenUsage | undefined, model: string | undefined, provider: ProviderId | undefined): Cost | undefined {
  if (!u || (provider && FREE.includes(provider))) return undefined;
  if (u.costUsd) return { usd: u.costUsd, estimated: false };
  if (!u.inputTokens && !u.outputTokens) return undefined;
  const price = priceFor(model, provider);
  if (!price) return undefined;
  const cached = Math.min(u.cachedTokens ?? 0, u.inputTokens ?? 0);
  const fresh = (u.inputTokens ?? 0) - cached;
  return { usd: (fresh * price.in + cached * price.cache + (u.outputTokens ?? 0) * price.out) / 1e6, estimated: true };
}

export const fmtUsd = (usd: number) => (usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(4)}`);
