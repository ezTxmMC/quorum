import type { Attachment, ChatSession, HubEvent, Persisted, ProviderId, RunRequest } from '../types';

export interface ChatJob {
  acknowledged?: boolean;
  forgotten?: boolean;
  runId: string;
  chatId?: string;
  messageId?: string;
  provider: ProviderId;
  title: string;
  createdAt: number;
  snapshot?: ChatSession;
  state: ChatJobState;
}
export interface ChatJobState {
  pid?: number;
  workerPid?: number;
  workerReady?: boolean;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  sequence: number;
  heartbeat: number;
}
export interface ChatWorkerBootstrap {
  supervisorPid?: number;
  processGroup?: number;
  request: RunRequest;
  dataRoot: string;
  jobDirectory: string;
  pythonRoot: string;
  settings: Persisted['settings'];
  apiKeys: Record<string, string>;
}
export interface ChatWorkerCommand {
  type: 'cancel' | 'inject';
  id?: string;
  expiresAt?: number;
  text?: string;
  attachments?: Attachment[];
}
export interface ChatJournalEvent { sequence: number; event: HubEvent }
