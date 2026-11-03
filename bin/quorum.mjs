#!/usr/bin/env node
// Launcher für Entwicklung und `npm link`: Terminal-Modi laufen direkt in Node (auch ohne Display), alles andere startet die App abgelöst vom Terminal.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const terminal = args[0] === 'plan' || args.some((a) => a === '--tui' || a === '-t' || a === '-p' || a === '--print' || a.startsWith('--print=') || a === '-h' || a === '--help' || a === '-v' || a === '--version');
const bundle = join(root, 'dist-cli', 'quorum.mjs');

if (terminal) {
  if (!existsSync(bundle)) { console.error('quorum: dist-cli/quorum.mjs fehlt – bitte "npm run build:cli" ausführen.'); process.exit(1); }
  await import(pathToFileURL(bundle).href);
} else {
  let electron;
  try { electron = createRequire(import.meta.url)('electron'); } catch { /* unten */ }
  if (typeof electron !== 'string') { console.error('quorum: Electron ist nicht installiert (npm install).'); process.exit(1); }
  const flags = process.platform === 'linux' ? ['--no-sandbox'] : [];
  spawn(electron, [root, ...flags, ...args], { detached: true, stdio: 'ignore', cwd: process.cwd() }).unref();
}
