import type { RuntimeId, Backend } from '../models';

export interface HfSearchHit {
  repo: string;
  downloads: number;
  likes: number;
  pipelineTag?: string;
  tags: string[];
  license?: string;
  lastModified?: string;
}

export interface HfFile {
  path: string;
  size: number;
}

export interface HfModelInfo {
  repo: string;
  revision: string;
  pipelineTag?: string;
  tags: string[];
  license?: string;
  files: HfFile[];
}

export interface LocalImageResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export type DownloadStatus = 'running' | 'paused' | 'done' | 'error';

export interface DownloadState {
  id: string;
  repo: string;
  status: DownloadStatus;
  files: { path: string; size: number; received: number }[];
  received: number;
  total: number;
  error?: string;
}

export interface Memory {
  vram: number;
  ram: number;
}

export interface ImageParams {
  prompt: string;
  negative?: string;
  steps?: number;
  guidance?: number;
  width?: number;
  height?: number;
  seed?: number;
}

export interface GpuStats {
  vendor: 'amd' | 'nvidia';
  name: string;
  vramTotal: number;
  vramUsed: number;
  busyPercent?: number;
}

export interface ResourceSnapshot {
  at: number;
  gpu?: GpuStats;
  ram: { total: number; used: number };
  cpu: { cores: number; load1: number };
}

export interface ModelStats {
  loads: number;
  requests: number;
  deltas: number;
  lastLoadMs?: number;
  lastUsed?: number;
}

export interface LoadedInfo {
  modelId: string;
  runtime: RuntimeId;
  backend: Backend;
  gpuLayers?: number;
  memory: Memory;
  inUse: number;
  lastUsed: number;
  stats: ModelStats;
}

export interface PyStatus {
  /** Umgebung eingerichtet und zu den Pins passend. */
  ready: boolean;
  python?: string;
  pythonVersion?: string;
  torch?: { version: string; hip?: string; cuda: boolean; device?: string };
  error?: string;
}
