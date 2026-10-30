// Agent Client Protocol (ACP): ein Client für viele Coding-Agenten (JSON-RPC über stdio). Vorlagen sind nur Startbefehle –
// Quorum startet ausschließlich Programme, die der Nutzer selbst installiert hat (kein automatisches npx/uvx).
export interface AcpAgent { id: string; name: string; command: string; args: string[] }

export const ACP_PRESETS: AcpAgent[] = [
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
  { id: 'kimi', name: 'Kimi Code', command: 'kimi', args: ['acp'] },
  { id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot', args: ['--acp'] },
  { id: 'cursor', name: 'Cursor Agent', command: 'agent', args: ['acp'] },
  { id: 'qwen', name: 'Qwen Code', command: 'qwen', args: ['--acp'] },
  { id: 'goose', name: 'Goose', command: 'goose', args: ['acp'] },
  { id: 'kiro', name: 'Kiro', command: 'kiro-cli', args: ['acp'] },
  { id: 'vibe', name: 'Mistral Vibe', command: 'vibe-acp', args: [] },
  { id: 'cline', name: 'Cline', command: 'cline', args: ['--acp'] },
  { id: 'auggie', name: 'Augment (auggie)', command: 'auggie', args: ['--acp'] },
  { id: 'kilo', name: 'Kilo Code', command: 'kilo', args: ['acp'] },
  { id: 'junie', name: 'Junie', command: 'junie', args: ['--acp=true'] },
];
