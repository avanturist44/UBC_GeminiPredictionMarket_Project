import 'server-only';
import { getRecorderStatus, type RecorderStatusRow } from '@thesis/db';
import { getDb } from './db';

export const STATUS_WINDOW_MINUTES = 5;

export type RecorderStatus =
  | { state: 'ok'; rows: RecorderStatusRow[]; recordingSymbols: number; latest: Date | null }
  | { state: 'not-configured' }
  | { state: 'error' };

/** Which tracked contracts received price points in the last few minutes. */
export async function loadRecorderStatus(): Promise<RecorderStatus> {
  const db = getDb();
  if (!db) return { state: 'not-configured' };
  try {
    const since = new Date(Date.now() - STATUS_WINDOW_MINUTES * 60_000);
    const rows = await getRecorderStatus(db, since);
    const recording = rows.filter((row) => row.points > 0);
    const latest = recording.reduce<Date | null>(
      (max, row) => (row.latestTs && (!max || row.latestTs > max) ? row.latestTs : max),
      null,
    );
    return { state: 'ok', rows, recordingSymbols: recording.length, latest };
  } catch (error) {
    // The message can name the database host or user. Keep it in the server log.
    console.error('recorder status query failed', error);
    return { state: 'error' };
  }
}
