import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { EditorDocument, WorkspaceEntry } from '../../shared/ide/types.ts';
import { workspacePath } from './paths.ts';

const MAX_FILE_BYTES = 2_000_000;
const hash = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');
const languages: Record<string, string> = { '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact', '.json': 'json', '.py': 'python', '.rs': 'rust', '.md': 'markdown', '.css': 'css', '.html': 'html' };

export class DocumentService {
  private readonly pending = new Map<string, Promise<unknown>>();

  async list(root: string, path = '.'): Promise<WorkspaceEntry[]> {
    const canonical = workspacePath(root, path);
    const entries = await fs.readdir(canonical, { withFileTypes: true });
    return entries.filter((entry) => !entry.isSymbolicLink() && !['.git', 'node_modules'].includes(entry.name))
      .map((entry) => ({ name: entry.name, path: join(canonical, entry.name), isDirectory: entry.isDirectory() }))
      .sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name));
  }

  async read(root: string, path: string): Promise<EditorDocument> {
    const canonical = workspacePath(root, path);
    const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
        throw new Error('Only text files up to 2 MB can be edited');
      }
      const bytes = await handle.readFile();
      if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) {
        throw new Error('Binary or oversized file cannot be edited');
      }
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { path: canonical, text, diskHash: hash(bytes), languageId: languages[extname(canonical)] ?? 'plaintext', lineEnding: text.includes('\r\n') ? 'CRLF' : 'LF', encoding: 'utf-8' };
    } finally {
      await handle.close();
    }
  }

  async save(root: string, path: string, text: string, expectedHash: string): Promise<EditorDocument> {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES || text.includes('\0')) {
      throw new Error('Invalid editor buffer');
    }
    const canonical = workspacePath(root, path);
    const previous = this.pending.get(canonical) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const before = await this.read(root, canonical);
      if (before.diskHash !== expectedHash) {
        throw new Error('Datei wurde auf dem Datenträger geändert. Änderungen vergleichen und neu laden.');
      }
      const stats = await fs.stat(canonical);
      const temporary = join(dirname(canonical), `.${basename(canonical)}.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, text, { flag: 'wx', mode: stats.mode & 0o777 });
        const current = await this.read(root, canonical);
        if (current.diskHash !== expectedHash || workspacePath(root, path) !== canonical) {
          throw new Error('Datei wurde während des Speicherns geändert');
        }
        await fs.rename(temporary, canonical);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return this.read(root, canonical);
    });
    this.pending.set(canonical, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(canonical) === operation) {
        this.pending.delete(canonical);
      }
    }
  }
}
