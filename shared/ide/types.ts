export interface EditorDocument {
  path: string;
  text: string;
  diskHash: string;
  languageId: string;
  lineEnding: 'LF' | 'CRLF';
  encoding: 'utf-8';
}
export interface WorkspaceEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface WorkspaceSearchResult {
  matches: { path: string; line: number; column: number; preview: string }[];
  truncated: boolean;
  scannedFiles: number;
}
export interface WorkspaceFileResult { files: string[]; truncated: boolean }
