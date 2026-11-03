export type LspLanguage = 'typescript' | 'python';
export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspDiagnostic {
  range: LspRange;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
}
export interface LspDiagnostics {
  root: string;
  language: LspLanguage;
  path: string;
  version: number;
  diagnostics: LspDiagnostic[];
}
export interface LspStatus {
  root: string;
  language: LspLanguage;
  state: 'starting' | 'ready' | 'stopped' | 'failed' | 'missing';
  message?: string;
}
export interface LspDocument {
  root: string;
  language: LspLanguage;
  path: string;
  languageId: string;
  text: string;
  version: number;
}
export type LspFeature = 'completion' | 'hover' | 'definition' | 'references';
export interface LspRequest {
  root: string;
  language: LspLanguage;
  path: string;
  version: number;
  feature: LspFeature;
  position: LspPosition;
}
export interface LspReply { version: number; result: unknown }
export type LspEvent = { type: 'status'; status: LspStatus } | { type: 'diagnostics'; diagnostics: LspDiagnostics };

export function lspLanguage(languageId: string): LspLanguage | undefined {
  if (['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(languageId)) {
    return 'typescript';
  }
  if (languageId === 'python') {
    return 'python';
  }
  return undefined;
}
