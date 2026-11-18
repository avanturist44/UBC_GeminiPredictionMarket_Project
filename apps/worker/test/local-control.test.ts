import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalWorkerControl, type LocalWorkerHealth } from '../src/local-control';

const health: LocalWorkerHealth = { pid: 123, startedAt: '2026-11-18T21:00:00Z', lastCycleAt: '2026-11-18T21:00:00Z',
  stopping: false, indexAgeMs: 1000, volatilityReturnCount: 12, streamConnected: true };
afterEach(() => { vi.useRealTimers(); });

it('is disabled for ordinary starts without local IPC paths', () => {
  const readHealth = vi.fn(() => health);
  const control = createLocalWorkerControl({ health: readHealth, requestStop: vi.fn(), onError: vi.fn() });
  control.close(); expect(readHealth).not.toHaveBeenCalled();
});

it('writes heartbeat progress atomically and requests graceful shutdown once', () => {
  vi.useFakeTimers();
  const folder = mkdtempSync(join(tmpdir(), 'thesis-worker-control-'));
  const file = join(folder, 'health.json'); const stop = join(folder, 'stop');
  const requestStop = vi.fn(); const onError = vi.fn();
  let snapshot = { ...health };
  const control = createLocalWorkerControl({ healthFile: file, stopFile: stop,
    health: () => snapshot, requestStop, onError, intervalMs: 1000 });
  try {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject(health);
    snapshot = { ...snapshot, lastCycleAt: '2026-11-18T21:01:00Z', volatilityReturnCount: 13 };
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ lastCycleAt: snapshot.lastCycleAt, volatilityReturnCount: 13 });
    writeFileSync(stop, 'stop'); vi.advanceTimersByTime(3000);
    expect(requestStop).toHaveBeenCalledTimes(1); expect(onError).not.toHaveBeenCalled();
    control.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    control.close(); rmSync(file, { force: true }); rmSync(stop, { force: true });
    rmSync(`${file}.tmp`, { force: true }); rmdirSync(folder);
  }
});

it('reports control-file write errors without crashing the trading worker', () => {
  const onError = vi.fn();
  const control = createLocalWorkerControl({ healthFile: join(tmpdir(), 'missing-parent-thesis-test', 'health.json'),
    health: () => health, requestStop: vi.fn(), onError });
  control.close(); expect(onError).toHaveBeenCalled();
});
