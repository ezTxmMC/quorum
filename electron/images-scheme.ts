import { net, protocol } from 'electron';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCHEME, imagesDir } from './images';

// Electron-Teil des Bilder-Schemas (getrennt von images.ts, damit die Kommandozeile images.ts ohne Electron laden kann).

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
