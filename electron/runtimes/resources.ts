// Ressourcen-Monitor: VRAM, GPU-Auslastung, RAM und CPU. AMD über sysfs (ohne Abhängigkeit), NVIDIA über nvidia-smi.
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

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

const DRM = '/sys/class/drm';

async function readNum(file: string): Promise<number | undefined> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** AMD-GPU über sysfs: erste Karte mit VRAM-Angaben. */
export async function readAmdGpu(root = DRM): Promise<GpuStats | undefined> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return undefined;
  }
  for (const card of entries.filter((c) => /^card\d+$/.test(c))) {
    const dev = join(root, card, 'device');
    const total = await readNum(join(dev, 'mem_info_vram_total'));
    const used = await readNum(join(dev, 'mem_info_vram_used'));
    if (!total || used === undefined) continue;
    let name = 'AMD-GPU';
    try {
      name = (await fsp.readFile(join(dev, 'product_name'), 'utf8')).trim() || name;
    } catch { /* ohne Produktname */ }
    const busyPercent = await readNum(join(dev, 'gpu_busy_percent'));
    return { vendor: 'amd', name, vramTotal: total, vramUsed: used, busyPercent };
  }
  return undefined;
}

/** NVIDIA-GPU über nvidia-smi (falls installiert). */
export function readNvidiaGpu(): Promise<GpuStats | undefined> {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const [name, total, used, busy] = String(stdout).trim().split('\n')[0].split(',').map((s) => s.trim());
      const mib = 1024 * 1024;
      resolve({ vendor: 'nvidia', name, vramTotal: Number(total) * mib, vramUsed: Number(used) * mib, busyPercent: Number(busy) });
    });
  });
}

export async function snapshot(): Promise<ResourceSnapshot> {
  const gpu = (await readAmdGpu()) ?? (await readNvidiaGpu());
  return {
    at: Date.now(),
    gpu,
    ram: { total: totalmem(), used: totalmem() - freemem() },
    cpu: { cores: cpus().length, load1: loadavg()[0] },
  };
}
