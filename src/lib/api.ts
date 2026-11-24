import type { HubApi } from '@shared/bridge';

declare global {
  interface Window { hub: HubApi }
}

export const hub = window.hub;
export const uid = () => crypto.randomUUID();
