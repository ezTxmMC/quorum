import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { LspLanguage } from '../../../shared/ide/lsp.ts';

export interface ServerCommand {
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  initializationOptions?: Record<string, unknown>;
}

export function installedServer(language: LspLanguage, resourcesPath?: string): ServerCommand {
  const require = createRequire(import.meta.url);
  const packageRoot = (name: string): string => {
    const packaged = resourcesPath ? join(resourcesPath, 'language-servers', 'node_modules', name) : undefined;
    if (packaged && existsSync(join(packaged, 'package.json'))) { return packaged; }
    return dirname(require.resolve(`${name}/package.json`));
  };
  const entry = language === 'typescript'
    ? join(packageRoot('typescript-language-server'), 'lib', 'cli.mjs')
    : join(packageRoot('pyright'), 'langserver.index.js');
  if (!existsSync(entry)) { throw new Error('Language server entry point is missing'); }
  const environment: NodeJS.ProcessEnv = {
    // Do not inherit API keys, preload hooks or workspace-controlled Node options.
    PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    SYSTEMROOT: process.env.SYSTEMROOT, SystemRoot: process.env.SystemRoot,
    TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    LANG: process.env.LANG, ELECTRON_RUN_AS_NODE: '1',
  };
  return {
    executable: process.execPath, args: [entry, '--stdio'], environment,
    initializationOptions: language === 'typescript' ? {
      hostInfo: 'Quorum', disableAutomaticTypingAcquisition: true,
      tsserver: { path: join(packageRoot('typescript'), 'lib', 'tsserver.js'), logVerbosity: 'off' },
      preferences: { includeCompletionsForModuleExports: true },
    } : undefined,
  };
}
