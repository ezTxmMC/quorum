# Quorum – Branding

> **Alle Modelle. Ein Tisch.**

## Name
**Quorum** – die Mindestzahl an Stimmen, die nötig ist, damit eine Gruppe entscheiden kann. Genau das macht die App:
Claude, Codex, Gemini, OpenCode & Ollama arbeiten zusammen, prüfen einander und liefern ein gemeinsames Ergebnis.

- kurz (6 Buchstaben), gut auszusprechen auf Deutsch und Englisch, kein Technik-Klischee wie „AI Hub"
- trägt die Kernfunktion (Multi-Agent) schon im Namen
- Alternativen, falls „Quorum" rechtlich/markentechnisch nicht passt: **Konklave**, **Tandem**, **Rondo**
  (vor einer Veröffentlichung Markenrecherche machen – „Quorum" ist ein gängiges Wort)

## Marke
Ein **abstraktes, scharfkantiges Zeichen** – ein Dreiecksring aus **drei Scherben** (drei Modelle), die sich um eine kleine
**weiße Mitte** gruppieren (der Konsens, das Quorum). Keine Rundungen: gerade Kanten, klare Winkel, kräftige Flächen.

| Teil | Bedeutung |
|---|---|
| linke Scherbe, Blau `#4F7BFF` | Modell 1 |
| rechte Scherbe, Violett `#8A6BFF` | Modell 2 |
| untere Scherbe, Schimmer `#C9D3FF` | Modell 3 |
| weißes Dreieck | das gemeinsame Ergebnis |

Die Geometrie liegt **einmal** in `shared/brand.ts`. Überall wird dieselbe Marke verwendet (`logo-mark.svg` / `favicon.svg`) – auf transparentem
Grund, ohne separates App-Icon mit Hintergrund: Titelleiste, Fenster-/Taskleisten-Icon, Tray-Icon und alle Paket-Icons.

## Dateien
| Datei | Zweck |
|---|---|
| `shared/brand.ts` | Geometrie + Rasterizer (Quelle für alles) |
| `scripts/make-icons.ts` | erzeugt `build/icon.png`, `icon.ico`, `icon.icns`, `build/icons/*.png` (läuft automatisch vor `npm run dist:*`) |
| `branding/logo-mark.svg` | Marke allein |
| `branding/logo-wordmark.svg` | Marke + „QUORUM" + Claim, 1200×630 |
| `public/favicon.svg` | Favicon |
| `src/components/Logo.tsx` | Marke in der App |

Icons neu erzeugen: `npm run icons`

## Farben
| Name | Hex |
|---|---|
| Hub-Blau | `#4F7BFF` |
| Hub-Violett | `#8A6BFF` |
| Schimmer | `#C9D3FF` |
| Nachtschwarz | `#0E0F13` |
| Weiß | `#FFFFFF` |

## Typografie
Wortmarke **QUORUM** in Versalien, schwere eckige Grotesk (Space Grotesk / Archivo Black / Montserrat ExtraBold), Sperrung +6 %.
Claim in Versalien, mittelstark, weit gesperrt, gedämpftes Grau-Blau. UI: Inter bzw. Systemschrift.

## Regeln
- Mindestgröße der Marke 16 px; Freiraum ringsum mindestens die Höhe der weißen Mitte ×2.
- Auf dunklem Grund (Standard) oder auf Weiß (dann Mitte dunkel `#0E0F13`).
- Nicht verzerren, drehen, abrunden, mit Schatten oder Verlauf füllen; Scherben nicht umordnen.

## Ton
Direkt, ruhig, präzise. Kurze Sätze. „Alle Modelle. Ein Tisch."
