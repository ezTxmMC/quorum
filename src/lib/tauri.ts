import { createHub } from '@shared/bridge';

interface TauriWindow {
  close(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  startDragging(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  setBackgroundColor(color: string): Promise<void>;
  onResized(callback: () => void): Promise<() => void>;
  onCloseRequested(callback: (event: { preventDefault(): void }) => void): Promise<() => void>;
}
interface TauriApi {
  core: { invoke<T>(name: string, args?: unknown): Promise<T> };
  event: { listen<T>(name: string, callback: (event: { payload: T }) => void): Promise<() => void> };
  window: { getCurrentWindow(): TauriWindow };
}
declare global { interface Window { __TAURI__?: TauriApi } }

interface CompletedWorkerMessage {
  chatId: string;
  messageId: string;
  runId: string;
}

function collectCompletedWorkers(profile: unknown): CompletedWorkerMessage[] {
  if (typeof profile !== 'object' || profile === null) {
    return [];
  }
  const sessions = (profile as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) {
    return [];
  }
  const completed: CompletedWorkerMessage[] = [];
  for (const session of sessions) {
    if (typeof session !== 'object' || session === null) {
      continue;
    }
    const chatId = (session as { id?: unknown }).id;
    const messages = (session as { messages?: unknown }).messages;
    if (typeof chatId !== 'string' || !Array.isArray(messages)) {
      continue;
    }
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) {
        continue;
      }
      const item = message as { id?: unknown; workerDone?: unknown; workerRunId?: unknown };
      if (item.workerDone === true && typeof item.id === 'string' && typeof item.workerRunId === 'string') {
        completed.push({ chatId, messageId: item.id, runId: item.workerRunId });
      }
    }
  }
  return completed;
}

export async function installTauri(api: TauriApi) {
  document.documentElement.dataset.tauri = '1';
  const current = api.window.getCurrentWindow();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const publish = (channel: string, payload: unknown) => {
    for (const cb of listeners.get(channel) ?? []) cb(payload);
  };
  await api.event.listen<{ channel: string; payload: unknown }>('quorum-event', ({ payload }) => publish(payload.channel, payload.payload));
  const state = async () => ({ maximized: await current.isMaximized(), fullscreen: await current.isFullscreen() });
  const dispatch = <T>(channel: string, args: unknown[] = []) => {
    const trimmed = [...args];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) {
      trimmed.pop();
    }
    return api.core.invoke<T>('dispatch', { channel, args: trimmed });
  };
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let writes = Promise.resolve<unknown>(undefined);
  let closing = false;
  const controls: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    'store:load': async () => {
      const raw = await api.core.invoke<ArrayBuffer>('load_profile');
      const profile = JSON.parse(decoder.decode(new Uint8Array(raw))) as { settings?: unknown };
      await dispatch('store:adopt', [{ settings: profile.settings }]);
      return profile;
    },
    'store:save': (profile) => {
      const pending = writes.then(async () => {
        const bytes = encoder.encode(JSON.stringify(profile));
        await api.core.invoke('save_profile', bytes);
        const settings = (profile as { settings?: unknown })?.settings;
        await dispatch('store:ack', [{ settings, completed: collectCompletedWorkers(profile) }]);
      });
      writes = pending.catch(() => {});
      return pending;
    },
    'win:state': state,
    'win:theme': async () => {},
    'win:minimize': () => current.minimize(),
    'win:maximize': () => current.toggleMaximize(),
    'win:close': () => current.close(),
    'chat:ready-close': async (_token, error) => {
      try {
        if (error) throw new Error(String(error));
        await dispatch('chat:close-window');
      } catch (reason) {
        await dispatch('chat:resume-starts').catch(() => {});
        window.alert(String(reason));
      } finally { closing = false; }
    },
  };
  window.hub = createHub({
    async invoke<T>(channel: string, ...args: unknown[]) {
      if (Object.hasOwn(controls, channel)) return await controls[channel](...args) as T;
      return dispatch<T>(channel, args);
    },
    sub<T>(channel: string, callback: (payload: T) => void) {
      const callbacks = listeners.get(channel) ?? new Set();
      listeners.set(channel, callbacks);
      const listener = (payload: unknown) => callback(payload as T);
      callbacks.add(listener);
      return () => callbacks.delete(listener);
    },
    platform: /Mac/.test(navigator.platform) ? 'darwin' : /Win/.test(navigator.platform) ? 'win32' : 'linux',
    pathForFile: () => '',
  });
  await current.onResized(() => {
    void state().then((next) => publish('win:state', next));
  });
  await current.onCloseRequested((event) => {
    if (!listeners.get('chat:prepare-close')?.size || !profileReady) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    publish('chat:prepare-close', crypto.randomUUID());
  });
}
let profileReady = false;
export function markProfileReady() { profileReady = true; }
