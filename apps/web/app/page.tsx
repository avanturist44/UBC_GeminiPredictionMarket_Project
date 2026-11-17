import { STATUS_WINDOW_MINUTES, loadRecorderStatus } from '@/lib/recorder-status';

export const dynamic = 'force-dynamic';

/** Decimal string between 0 and 1 to whole cents, without float arithmetic on money. */
function cents(price: string | null): string {
  if (price === null) return '–';
  return `${Math.round(Number(price) * 100)}¢`;
}

function timeUtc(date: Date | null): string {
  return date ? `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '–';
}

export default async function Home() {
  const status = await loadRecorderStatus();

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Every bet comes with a thesis</h1>
        <p className="text-zinc-600">
          The feeds arrive in the next build phases. For now this page shows the markets being
          recorded from Gemini Prediction Markets.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Price recorder</h2>

        {status.state === 'not-configured' && (
          <p className="rounded-md border border-zinc-200 p-4 text-sm text-zinc-700">
            No database is connected. Set <code>DATABASE_URL</code> and reload.
          </p>
        )}

        {status.state === 'error' && (
          <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            Could not read the database. The server log has the details.
          </p>
        )}

        {status.state === 'ok' && status.rows.length === 0 && (
          <p className="rounded-md border border-zinc-200 p-4 text-sm text-zinc-700">
            No markets recorded yet. Start the worker and reload in a minute.
          </p>
        )}

        {status.state === 'ok' && status.rows.length > 0 && (
          <>
            <p className="text-sm text-zinc-700">
              <span className="font-medium">{status.recordingSymbols}</span> of {status.rows.length}{' '}
              tracked contracts received prices in the last {STATUS_WINDOW_MINUTES} minutes. Latest:{' '}
              {timeUtc(status.latest)}.
            </p>
            <div className="overflow-x-auto rounded-md border border-zinc-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Market</th>
                    <th className="px-3 py-2 font-medium">YES bid</th>
                    <th className="px-3 py-2 font-medium">YES ask</th>
                    <th className="px-3 py-2 font-medium">Expires</th>
                    <th className="px-3 py-2 font-medium">Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {status.rows.map((row) => (
                    <tr key={row.instrumentSymbol}>
                      <td className="px-3 py-2">
                        <div className="font-medium">
                          {row.title}
                          {row.contractLabel ? ` · ${row.contractLabel}` : ''}
                        </div>
                        <div className="font-mono text-xs text-zinc-500">{row.instrumentSymbol}</div>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{cents(row.yesBid)}</td>
                      <td className="px-3 py-2 tabular-nums">{cents(row.yesAsk)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-zinc-600">{timeUtc(row.expiryAt)}</td>
                      <td className="px-3 py-2 tabular-nums">{row.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
