import { NextResponse } from 'next/server';
import { STATUS_WINDOW_MINUTES, loadRecorderStatus } from '@/lib/recorder-status';

export const dynamic = 'force-dynamic';

/** Liveness of the web app and of the worker's price recorder. */
export async function GET() {
  const status = await loadRecorderStatus();
  if (status.state === 'not-configured') {
    return NextResponse.json(
      { ok: false, code: 'not_configured', message: 'DATABASE_URL is not set' },
      { status: 503 },
    );
  }
  if (status.state === 'error') {
    return NextResponse.json({ ok: false, code: 'db_error', message: status.message }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    tradingMode: process.env.TRADING_MODE ?? 'paper',
    recorder: {
      windowMinutes: STATUS_WINDOW_MINUTES,
      recordingSymbols: status.recordingSymbols,
      latestPricePointAt: status.latest,
      symbols: status.rows.map((row) => ({
        symbol: row.instrumentSymbol,
        points: row.points,
        latestAt: row.latestTs,
      })),
    },
  });
}
