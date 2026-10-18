import type { HubApi } from '../../electron/preload';

declare global {
  interface Window { hub: HubApi }
}

export const hub = window.hub;
export const uid = () => crypto.randomUUID();
