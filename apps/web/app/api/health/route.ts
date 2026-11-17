import { NextResponse } from 'next/server';
import { STATUS_WINDOW_MINUTES, loadRecorderStatus } from '@/lib/recorder-status';

export const dynamic = 'force-dynamic';

/**
 * Health of the web app and of the worker's price recorder.
 * 200 only while the recorder has written price points in the last few minutes.
 */
export async function GET() {
  const status = await loadRecorderStatus();
  if (status.state === 'not-configured') {
    return NextResponse.json(
      { ok: false, code: 'not_configured', message: 'DATABASE_URL is not set' },
      { status: 503 },
    );
  }
  if (status.state === 'error') {
    return NextResponse.json(
      { ok: false, code: 'db_error', message: 'The database could not be read' },
      { status: 503 },
    );
  }

  const recorder = {
    windowMinutes: STATUS_WINDOW_MINUTES,
    recordingSymbols: status.recordingSymbols,
    latestPricePointAt: status.latest,
    symbols: status.rows.map((row) => ({
      symbol: row.instrumentSymbol,
      points: row.points,
      latestAt: row.latestTs,
    })),
  };
  const tradingMode = process.env.TRADING_MODE ?? 'paper';

  if (status.recordingSymbols === 0) {
    return NextResponse.json(
      {
        ok: false,
        code: 'recorder_idle',
        message: `No price points were recorded in the last ${STATUS_WINDOW_MINUTES} minutes`,
        tradingMode,
        recorder,
      },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, tradingMode, recorder });
}
