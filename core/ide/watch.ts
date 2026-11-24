import { watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { workspacePath } from './paths.ts';

export interface FileChange { path: string; error?: string }

/** Watch parents so atomic saves and delete/recreate retain the subscription. */
export function watchDocuments(root: string, paths: string[], changed: (change: FileChange) => void) {
  const directories = new Map<string, Set<string>>();
  for (const path of paths) {
    const canonical = workspacePath(root, path);
    const directory = dirname(canonical);
    const files = directories.get(directory) ?? new Set();
    files.add(canonical);
    directories.set(directory, files);
  }
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const notify = (path: string) => {
    clearTimeout(pending.get(path));
    pending.set(path, setTimeout(() => { pending.delete(path); changed({ path }); }, 60));
  };
  const close = () => {
    for (const watcher of watchers) watcher.close();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  };
  try {
    for (const [directory, files] of directories) {
      const watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (!name) { for (const path of files) notify(path); return; }
        const path = join(directory, name);
        if (files.has(path)) notify(path);
      });
      watcher.on('error', (error) => changed({ path: directory, error: error.message }));
      watchers.push(watcher);
    }
  } catch (error) { close(); throw error; }
  return close;
}
