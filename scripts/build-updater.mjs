import { execFileSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Das Update-Fenster wird nur für den AppImage-Austausch gebraucht; Windows und macOS aktualisieren über ihren Installer.
if (process.platform !== 'linux') {
  process.exit(0);
}

const root = resolve(import.meta.dirname, '..');
const crate = join(root, 'native', 'updater');
execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', join(crate, 'Cargo.toml')], { stdio: 'inherit' });
const output = join(root, 'native', 'bin');
await mkdir(output, { recursive: true });
await copyFile(join(crate, 'target', 'release', 'quorum-updater'), join(output, 'quorum-updater'));
