import { existsSync, renameSync, writeFileSync } from 'node:fs';

export interface LocalWorkerHealth {
  pid: number;
  startedAt: string;
  lastCycleAt: string;
  stopping: boolean;
  indexAgeMs: number | null;
  volatilityReturnCount: number;
  streamConnected: boolean;
}

/** Optional local supervisor IPC. No paths are enabled for normal/Railway starts. */
export function createLocalWorkerControl(options: {
  healthFile?: string; stopFile?: string; health: () => LocalWorkerHealth;
  requestStop: () => void; onError: () => void; intervalMs?: number;
}) {
  if (!options.healthFile && !options.stopFile) return { close() {} };
  let stopRequested = false;
  const tick = () => {
    try {
      if (!stopRequested && options.stopFile && existsSync(options.stopFile)) {
        stopRequested = true;
        options.requestStop();
      }
      if (options.healthFile) {
        const temporary = `${options.healthFile}.tmp`;
        writeFileSync(temporary, JSON.stringify({ ...options.health(), updatedAt: new Date().toISOString() }));
        renameSync(temporary, options.healthFile);
      }
    } catch { options.onError(); }
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? 5000);
  return { close() { clearInterval(timer); tick(); } };
}
