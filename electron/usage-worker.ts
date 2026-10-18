import { parentPort } from 'node:worker_threads';
import { scanUsage } from './usage';

// Eigener Thread für das Auswerten der CLI-Verläufe – große JSONL-Dateien blockieren so weder den Hauptprozess noch die Oberfläche.
parentPort?.on('message', async (id: number) => {
  try { parentPort!.postMessage({ id, report: await scanUsage() }); } catch (e) { parentPort!.postMessage({ id, error: (e as Error).message }); }
});
