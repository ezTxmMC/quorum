import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { WorkspaceFileResult, WorkspaceSearchResult } from '../../shared/ide/types.ts';
import { DocumentService } from './documents.ts';
import { workspacePath, workspaceRoot } from './paths.ts';

const MAX_FILES = 10_000;
const MAX_DIRECTORIES = 2000;
const MAX_SEARCH_BYTES = 32_000_000;
const MAX_MATCHES = 200;
const IGNORED_DIRECTORIES = new Set(['.git', '.aws', '.ssh', '.gnupg', '.azure', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'dist-cli', 'dist-electron', 'build', '.next', '.cache', 'coverage']);
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|dsa|ecdsa)(?:\..*)?|credentials(?:\..*)?)$|\.(?:pem|p12|pfx|key)$/i;

async function candidates(root: string, signal?: AbortSignal): Promise<WorkspaceFileResult> {
  const canonical = workspaceRoot(root);
  const queue = [canonical];
  const files: string[] = [];
  let directories = 0;
  while (queue.length && files.length < MAX_FILES && directories < MAX_DIRECTORIES) {
    signal?.throwIfAborted();
    const directory = queue.shift();
    if (!directory) { break; }
    directories++;
    let entries;
    try { entries = await fs.readdir(workspacePath(canonical, directory), { withFileTypes: true }); }
    catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) { continue; }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && queue.length < MAX_DIRECTORIES) { queue.push(join(directory, entry.name)); }
        continue;
      }
      if (!entry.isFile() || SENSITIVE_FILE.test(entry.name)) { continue; }
      files.push(join(directory, entry.name));
      if (files.length >= MAX_FILES) { break; }
    }
  }
  return { files, truncated: files.length >= MAX_FILES || queue.length > 0 };
}

export class WorkspaceSearch {
  private readonly documents = new DocumentService();

  async files(root: string, query: string, signal?: AbortSignal): Promise<WorkspaceFileResult> {
    if (typeof query !== 'string' || query.length > 200) { throw new Error('Invalid filename query'); }
    const result = await candidates(root, signal);
    const needle = query.toLocaleLowerCase();
    const matches = result.files.filter((path) => relative(root, path).toLocaleLowerCase().includes(needle));
    return { files: matches.slice(0, 100), truncated: result.truncated || matches.length > 100 };
  }

  async search(root: string, query: string, signal?: AbortSignal): Promise<WorkspaceSearchResult> {
    if (typeof query !== 'string' || !query || query.length > 200) { throw new Error('Search query must contain 1–200 characters'); }
    const candidatesList = await candidates(root, signal);
    const result: WorkspaceSearchResult = { matches: [], truncated: candidatesList.truncated, scannedFiles: 0 };
    let bytes = 0;
    for (const path of candidatesList.files) {
      signal?.throwIfAborted();
      if (bytes >= MAX_SEARCH_BYTES || result.matches.length >= MAX_MATCHES) { result.truncated = true; break; }
      try {
        const document = await this.documents.read(root, path);
        bytes += Buffer.byteLength(document.text);
        result.scannedFiles++;
        const lines = document.text.split(/\r\n|\r|\n/);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          let column = line.indexOf(query);
          while (column >= 0 && result.matches.length < MAX_MATCHES) {
            result.matches.push({ path: document.path, line: index + 1, column: column + 1, preview: line.slice(Math.max(0, column - 60), column + query.length + 100) });
            column = line.indexOf(query, column + query.length);
          }
          if (result.matches.length >= MAX_MATCHES) { result.truncated = true; break; }
        }
      } catch (error) {
        signal?.throwIfAborted();
        // Binary, oversized, deleted and inaccessible files are not searchable text documents.
        if (!(error instanceof Error)) { throw error; }
      }
    }
    return result;
  }
}
