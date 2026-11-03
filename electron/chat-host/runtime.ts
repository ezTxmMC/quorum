import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface DurableChatRuntime { executable: string; worker: string; pythonRoot: string }

async function sources(root: string, prefix = ''): Promise<{ name: string; bytes: Buffer }[]> {
  const entries = await fs.readdir(join(root, prefix), { withFileTypes: true });
  const output: { name: string; bytes: Buffer }[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || entry.name === '__pycache__') { continue; }
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) { output.push(...await sources(root, name)); continue; }
    if (!entry.isFile() || !/\.(?:js|mjs|py|txt)$/.test(entry.name)) { continue; }
    output.push({ name, bytes: await fs.readFile(join(root, name)) });
  }
  return output;
}

/** Keep code and Python assets outside transient AppImage mounts while detached chats finish. */
export async function stageChatRuntime(dataRoot: string, executable: string, worker: string, pythonRoot: string): Promise<DurableChatRuntime> {
  const scripts = await sources(dirname(worker));
  const python = await sources(pythonRoot);
  const binary = await fs.readFile(executable);
  const digest = createHash('sha256').update(binary);
  for (const file of scripts) { digest.update(`js:${file.name}\0`).update(file.bytes); }
  for (const file of python) { digest.update(`py:${file.name}\0`).update(file.bytes); }
  const parent = join(dataRoot, 'chat-runtimes');
  const root = join(parent, digest.digest('hex').slice(0, 24));
  const result = { executable: join(root, basename(executable)), worker: join(root, 'adapter', basename(worker)), pythonRoot: join(root, 'python') };
  try { await fs.access(join(root, 'ready')); return result; }
  catch { /* Build a complete private version before publishing its directory. */ }
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.stage-${randomUUID()}`);
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    for (const [directory, files] of [['adapter', scripts], ['python', python]] as const) {
      for (const file of files) {
        const target = join(temporary, directory, file.name);
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, file.bytes, { mode: 0o600 });
      }
    }
    await fs.writeFile(join(temporary, 'adapter', 'package.json'), JSON.stringify({ type: 'module' }), { mode: 0o600 });
    await fs.writeFile(join(temporary, basename(executable)), binary, { mode: 0o700 });
    await fs.writeFile(join(temporary, 'ready'), '', { mode: 0o600 });
    try { await fs.rename(temporary, root); }
    catch (error) {
      try { await fs.access(join(root, 'ready')); }
      catch { throw error; }
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return result;
}
