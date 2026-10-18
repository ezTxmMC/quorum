#!/usr/bin/env node
/**
 * Release Tagging Helper für Quorum
 * 
 * Kanäle:
 *   - dev:     1.0.0-dev.<erste 8 Commit-Zeichen>
 *   - beta:    1.0.0-beta.<auto increment nummer> (z. B. 1.0.0-beta.1)
 *   - release: 1.0.0-release.<auto increment nummer> (z. B. 1.0.0-release.1)
 * 
 * Aufruf:
 *   node scripts/release.ts dev [--push]
 *   node scripts/release.ts beta [--push]
 *   node scripts/release.ts release [--push]
 *   node scripts/release.ts next <dev|beta|release>
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const BASE_VERSION = '1.0.0';

function run(cmd: string): string {
  try {
    return execSync(cmd, { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function getCommitHash(): string {
  const hash = run('git rev-parse --short=8 HEAD');
  if (!hash) {
    throw new Error('Konnte Git-Commit-Hash nicht ermitteln.');
  }
  return hash;
}

function getAllTags(): string[] {
  const out = run('git tag -l');
  return out ? out.split('\n').map((t) => t.trim()).filter(Boolean) : [];
}

export function getNextTag(channel: 'dev' | 'beta' | 'release'): string {
  const tags = getAllTags();

  if (channel === 'dev') {
    const hash = getCommitHash();
    return `${BASE_VERSION}-dev.${hash}`;
  }

  // Suche nach höchsten Zahlen für beta oder release
  const prefix = `${BASE_VERSION}-${channel}.`;
  let highestNum = 0;

  for (const tag of tags) {
    const clean = tag.replace(/^v/, '');
    if (clean.startsWith(prefix)) {
      const numStr = clean.slice(prefix.length);
      const num = parseInt(numStr, 10);
      if (!isNaN(num) && num > highestNum) {
        highestNum = num;
      }
    }
  }

  const nextNum = highestNum + 1;
  return `${prefix}${nextNum}`;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
Verwendung:
  node scripts/release.ts <dev|beta|release> [--push]
  node scripts/release.ts next <dev|beta|release>

Beispiele:
  node scripts/release.ts dev               # Erzeugt dev-Tag für aktuellen Commit
  node scripts/release.ts beta --push       # Erzeugt nächsten beta-Tag und pusht zu Origin
  node scripts/release.ts release --push    # Erzeugt nächsten release-Tag und pusht zu Origin
  node scripts/release.ts next beta         # Gibt nächsten Tag-Namen aus
`);
    return;
  }

  if (command === 'next') {
    const channel = (args[1] || 'dev') as 'dev' | 'beta' | 'release';
    if (!['dev', 'beta', 'release'].includes(channel)) {
      console.error(`Ungültiger Kanal: ${channel}. Gültig: dev, beta, release`);
      process.exit(1);
    }
    const tag = getNextTag(channel);
    console.log(tag);
    return;
  }

  const channel = command as 'dev' | 'beta' | 'release';
  if (!['dev', 'beta', 'release'].includes(channel)) {
    console.error(`Unbekannter Befehl/Kanal: ${command}. Gültig: dev, beta, release, next`);
    process.exit(1);
  }

  const push = args.includes('--push');
  const nextTag = getNextTag(channel);

  console.log(`\x1b[1;34m==>\x1b[0m Kanal: \x1b[1m${channel}\x1b[0m`);
  console.log(`\x1b[1;34m==>\x1b[0m Neuer Tag: \x1b[1;32m${nextTag}\x1b[0m`);

  // Aktualisiere package.json
  const pkgPath = join(rootDir, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.version = nextTag;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`\x1b[1;34m==>\x1b[0m package.json aktualisiert auf ${nextTag}`);
  } catch (e) {
    console.warn('Konnte package.json nicht aktualisieren:', e);
  }

  // Tag anlegen
  console.log(`\x1b[1;34m==>\x1b[0m Erstelle lokalen Git-Tag: ${nextTag}`);
  try {
    execSync(`git tag -a "${nextTag}" -m "Release ${nextTag} (${channel})"`, { cwd: rootDir, stdio: 'inherit' });
  } catch {
    console.error(`Fehler beim Erstellen des Tags "${nextTag}" (evtl. existiert er bereits).`);
    process.exit(1);
  }

  if (push) {
    console.log(`\x1b[1;34m==>\x1b[0m Pushe Tag zu Remote (origin) …`);
    try {
      execSync(`git push origin "${nextTag}"`, { cwd: rootDir, stdio: 'inherit' });
      console.log(`\x1b[1;32m✔ Tag erfolgreich gepusht!\x1b[0m GitHub Actions startet nun den Build.`);
    } catch {
      console.error(`Fehler beim Pushen des Tags zu origin.`);
      process.exit(1);
    }
  } else {
    console.log(`\n\x1b[1;33mHinweis:\x1b[0m Tag wurde lokal erstellt. Zum Pushen ausführen:\n  git push origin "${nextTag}"`);
  }
}

void main();
