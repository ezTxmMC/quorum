import type { ChatMode, ChatSession, ProviderId, ProviderOptions } from './types';

export const CHAT_MODES: { id: ChatMode; label: string; icon: string; description: string }[] = [
  { id: 'text', label: 'Text', icon: 'lucide:message-circle', description: 'Fragen, schreiben und besprechen' },
  { id: 'coding', label: 'Coding', icon: 'lucide:code-2', description: 'Mit Dateien und Werkzeugen am Projekt arbeiten' },
  { id: 'image', label: 'Bildgenerierung', icon: 'lucide:image', description: 'Bilder erzeugen und bearbeiten' },
  { id: 'model', label: 'Modellgenerierung', icon: 'lucide:cuboid', description: '3D-Modelle mit Texturen und Animationen erstellen' },
];

/** Existing sessions retain their coding behavior; image selections remain image chats. */
export const chatMode = (options: ProviderOptions): ChatMode => options.imageGen ? 'image' : options.chatMode ?? 'coding';

export function modeOptions(options: ProviderOptions, mode: ChatMode): ProviderOptions {
  return { ...options, chatMode: mode, imageGen: mode === 'image' ? options.imageGen : undefined };
}

export function switchChatMode(session: Pick<ChatSession, 'provider' | 'options' | 'modeSettings'>, next: ChatMode, engines: { id: string; provider: ProviderId }[]): Partial<ChatSession> {
  const current = chatMode(session.options);
  if (current === next) return {};
  const remembered = session.modeSettings?.[next];
  let provider = remembered?.provider ?? session.provider;
  let options = modeOptions(remembered?.options ?? session.options, next);
  if (next === 'image' && !options.imageGen) {
    const engine = engines.find((entry) => entry.provider === provider) ?? engines[0];
    if (engine) { provider = engine.provider; options = { ...options, model: undefined, imageGen: engine.id, effort: undefined, speed: undefined }; }
  }
  return { provider, options, providerSessions: {}, modeSettings: { ...session.modeSettings, [current]: { provider: session.provider, options: session.options } } };
}

/** Effective request options; switching modes does not overwrite saved coding permissions. */
export function textOptions(provider: ProviderId, options: ProviderOptions): ProviderOptions {
  return {
    ...options, chatMode: 'text', imageGen: undefined, fullAccess: false,
    permission: provider === 'opencode' ? undefined : 'plan', sandbox: 'read-only', approvalPolicy: 'never',
    addDirs: undefined, extraArgs: undefined, configOverrides: undefined, profile: undefined,
    agent: provider === 'opencode' ? 'plan' : undefined, agentsJson: undefined, allowedTools: undefined, mcpConfig: undefined,
    worktree: false, chrome: false, ultracode: false,
    systemPrompt: [options.systemPrompt, 'Reply directly in text. Do not use tools, run commands, inspect or modify files.'].filter(Boolean).join('\n\n'),
  };
}
