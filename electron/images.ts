import { net, protocol } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HubEvent, ProviderId } from '../shared/types';
import { dataDir } from './store';

// Bildgenerierung: Codex (eingebautes image_gen = GPT Image über den ChatGPT-Plan) und Antigravity (Nano Banana) melden erzeugte
// Bilder nicht im JSON-Strom, sondern legen sie in ihren eigenen Ordnern ab. Der Collector beobachtet diese Ordner während eines
// Laufs, kopiert neue Bilder in die App-Daten (bleiben so auch erhalten, wenn die CLI aufräumt) und meldet sie als `image`-Event.

export const SCHEME = 'quorum-img';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export const imagesDir = () => {
  const d = join(dataDir(), 'images');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
};

function sourceDir(provider: ProviderId, sessionId: string): string | null {
  if (provider === 'codex') return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images', sessionId);
  if (provider === 'antigravity') return join(homedir(), '.gemini', 'antigravity-cli', 'brain', sessionId);
  return null;
}

export const collectsImages = (p: ProviderId) => p === 'codex' || p === 'antigravity';

/** Speichert Bilddaten (Base64) in den App-Daten und liefert den Pfad. */
export async function storeImage(b64: string, ext = '.png'): Promise<string> {
  const p = join(imagesDir(), `${randomUUID()}${ext}`);
  await writeFile(p, Buffer.from(b64, 'base64'));
  return p;
}

export class ImageCollector {
  private dirs = new Set<string>();
  private seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning: Promise<void> = Promise.resolve();
  private readonly since = Date.now() - 1500;

  constructor(private provider: ProviderId, private emit: (e: HubEvent) => void, private engine?: string) {
    this.timer = setInterval(() => void this.scan(false), 2000);
  }

  setSession(id: string) {
    const d = sourceDir(this.provider, id);
    if (d) this.dirs.add(d);
  }

  /** Neue, fertig geschriebene Bilder übernehmen (beim Abschluss alle). */
  private scan(final: boolean): Promise<void> {
    this.scanning = this.scanning.then(async () => {
      for (const dir of this.dirs) {
        let names: string[];
        try { names = await readdir(dir); } catch { continue; }
        for (const n of names.sort()) {
          const src = join(dir, n);
          if (this.seen.has(src) || !IMAGE_EXT.has(extname(n).toLowerCase())) continue;
          try {
            const st = await stat(src);
            if (!st.isFile() || st.mtimeMs < this.since) { this.seen.add(src); continue; }
            if (!final && Date.now() - st.mtimeMs < 1000) continue; // wird evtl. noch geschrieben
            this.seen.add(src);
            const dest = join(imagesDir(), `${randomUUID()}${extname(n).toLowerCase()}`);
            await copyFile(src, dest);
            this.emit({ type: 'image', path: dest, engine: this.engine });
          } catch { /* Datei verschwunden */ }
        }
      }
    });
    return this.scanning;
  }

  async finish(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Unteragenten (z. B. Nano Banana) schreiben teils knapp nach Prozessende – kurz nachfassen.
    await this.scan(true);
    if (this.provider === 'antigravity') { await new Promise((r) => setTimeout(r, 800)); await this.scan(true); }
  }
}

/** Vor app.ready aufrufen. */
export function registerImageScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
}

/** quorum-img://local/<pfad> – liefert nur Dateien aus dem Bilderordner der App aus. */
export function handleImageScheme() {
  protocol.handle(SCHEME, (req) => {
    // Pfad ist komplett URL-kodiert: quorum-img://local/%2Fhome%2F…
    const p = resolve(decodeURIComponent(new URL(req.url).pathname.slice(1)));
    if (!p.startsWith(resolve(imagesDir()) + sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });
}

// ---- Bildmodus: Prompt für die Engine ------------------------------------------------------------------------------

export function imagePrompt(engine: string, prompt: string, refs: number): string {
  const ref = refs ? `\n${refs} reference image(s) are attached. Use them as input (edit, vary or match their style) only if the request refers to them; otherwise ignore them.` : '';
  if (engine === 'gpt-image') {
    return `Use your built-in image_gen tool to create the image requested below. Do not write code, do not create or modify any files, and do not use the CLI/API fallback.${ref}
When the image is done, reply with one short sentence in the language of the request.

Request:
${prompt}`;
  }
  return `Generate the image requested below with your image generation capability (Nano Banana). Wait until the image has been fully generated before replying. Do not create or modify any project files.${ref}
When the image is done, reply with one short sentence in the language of the request.

Request:
${prompt}`;
}
