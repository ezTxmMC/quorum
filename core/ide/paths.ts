import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function workspaceRoot(root: string): string {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('Workspace root is required');
  }
  const canonical = realpathSync(root);
  if (!statSync(canonical).isDirectory()) {
    throw new Error('Workspace must be a directory');
  }
  return canonical;
}

export function workspacePath(root: string, path: string): string {
  const canonicalRoot = workspaceRoot(root);
  if (typeof path !== 'string' || path.includes('\0')) {
    throw new Error('Invalid workspace path');
  }
  const canonical = realpathSync(resolve(canonicalRoot, path));
  const local = relative(canonicalRoot, canonical);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error('Access outside workspace denied');
  }
  return canonical;
}
