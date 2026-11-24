import { createHub } from '@shared/bridge';

interface TauriWindow {
  close(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  setBackgroundColor(color: string): Promise<void>;
  onCloseRequested(callback: (event: { preventDefault(): void }) => void): Promise<() => void>;
}
interface TauriApi {
  core: { invoke<T>(name: string, args: Record<string, unknown>): Promise<T> };
  event: { listen<T>(name: string, callback: (event: { payload: T }) => void): Promise<() => void> };
  window: { getCurrentWindow(): TauriWindow };
}
declare global { interface Window { __TAURI__?: TauriApi } }

export async function installTauri(api: TauriApi) {
  const current = api.window.getCurrentWindow();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const publish = (channel: string, payload: unknown) => {
    for (const cb of listeners.get(channel) ?? []) cb(payload);
  };
  await api.event.listen<{ channel: string; payload: unknown }>('quorum-event', ({ payload }) => publish(payload.channel, payload.payload));
  const state = async () => ({ maximized: await current.isMaximized(), fullscreen: await current.isFullscreen() });
  const dispatch = <T>(channel: string, args: unknown[] = []) => api.core.invoke<T>('dispatch', { channel, args });
  let writes = Promise.resolve<unknown>(undefined);
  let closing = false;
  const controls: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    'store:save': (profile) => {
      const pending = writes.then(() => dispatch('store:save', [profile]));
      writes = pending.catch(() => {});
      return pending;
    },
    'win:state': state,
    'win:theme': (color) => current.setBackgroundColor(String(color)),
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
