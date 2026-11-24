import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHIM = /\.(cmd|bat)$/i;
const SHIM_ENTRY = /"%~?dp0%\\([^"]+?\.(?:c?js|mjs))"/i;
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export interface ShimLaunch {
  cmd: string;
  args: string[];
  /** Die Argumente sind bereits für cmd.exe maskiert und dürfen nicht erneut in Anführungszeichen gesetzt werden. */
  verbatim?: boolean;
}

export function isWindowsShim(bin: string): boolean {
  return process.platform === 'win32' && SHIM.test(bin);
}

/** npm legt für jede CLI eine .cmd-Hülle an, die nur `node <skript>` aufruft. Das Skript direkt zu starten umgeht cmd.exe – und damit dessen Probleme mit Zeilenumbrüchen und Sonderzeichen in Prompts. */
function shimEntry(bin: string): string | undefined {
  try {
    const relative = SHIM_ENTRY.exec(readFileSync(bin, 'utf8'))?.[1];
    const entry = relative ? join(dirname(bin), relative) : undefined;
    return entry && existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

function nodeBinary(bin: string): string {
  const bundled = join(dirname(bin), 'node.exe');
  return existsSync(bundled) ? bundled : 'node';
}

/** Maskierung nach dem Verfahren von cross-spawn; .cmd-Hüllen werten die Zeile zweimal aus, daher doppelt. */
function escapeArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(META_CHARS, '^$1').replace(META_CHARS, '^$1');
}

/** Node startet .cmd/.bat nicht mehr direkt (EINVAL); solche CLIs laufen über ihr Node-Skript oder notfalls über cmd.exe. */
export function shimLaunch(bin: string, args: string[]): ShimLaunch {
  const entry = shimEntry(bin);
  if (entry) {
    return { cmd: nodeBinary(bin), args: [entry, ...args] };
  }
  const line = [bin.replace(META_CHARS, '^$1'), ...args.map(escapeArgument)].join(' ');
  return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}
