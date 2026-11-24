import type { ProviderId } from './types';

export interface CliPackage {
  /** Name im npm-Verzeichnis. */
  name: string;
  /** Kleinste Node.js-Version laut Paket (Major, Minor). */
  minNode: [number, number];
}

/** Offizielle npm-Pakete der Anbieter-CLIs. Antigravity hat keines und lässt sich deshalb nicht aus der App installieren. */
export const CLI_PACKAGES: Partial<Record<ProviderId, CliPackage>> = {
  claude: { name: '@anthropic-ai/claude-code', minNode: [22, 0] },
  codex: { name: '@openai/codex', minNode: [16, 0] },
  opencode: { name: 'opencode-ai', minNode: [18, 0] },
  kimi: { name: '@moonshot-ai/kimi-code', minNode: [22, 19] },
};

export interface InstallCheck {
  ok: boolean;
  text: string;
  /** Nur ein Hinweis: die Installation ist trotzdem möglich. */
  warning?: boolean;
}

/** Was eine Installation tun würde – wird vor dem Start angezeigt und direkt davor erneut geprüft. */
export interface HostInstallPlan {
  provider: ProviderId;
  /** false, wenn es für den Anbieter kein Paket gibt. */
  available: boolean;
  /** Alle Prüfungen bestanden: die Installation darf starten. */
  ready: boolean;
  package?: string;
  /** Der Befehl, der ausgeführt wird. */
  command?: string;
  /** Ordner, in dem das Programm danach liegt. */
  binDir?: string;
  checks: InstallCheck[];
}

/** Neuere npm-Versionen führen Installationsskripte nur für ausdrücklich erlaubte Pakete aus. */
export function npmInstallArgs(pkg: string, prefix?: string): string[] {
  return ['install', '--global', ...(prefix ? ['--prefix', prefix] : []), '--no-fund', '--no-audit', `--allow-scripts=${pkg}`, pkg];
}
