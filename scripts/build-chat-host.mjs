import { copyFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = join(root, 'native', 'chat-host', 'target');
const output = join(root, 'native', 'bin');
await mkdir(output, { recursive: true });
const name = process.platform === 'win32' ? 'quorum-chat-host.exe' : 'quorum-chat-host';
await copyFile(join(target, 'release', name), join(output, name));
