'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cents } from '@/lib/format';
import { timeTicks } from '@/lib/format';
import type { ChartPoint, ChartSeries, ThesisMarker } from '@/lib/market-view';

/**
 * YES price over time, with one mark per thesis at the moment it was published.
 * A mark's colour says who wrote it (accent for AI, ink for a person) and its direction says
 * which side it took (up for YES, down for NO). Green and red stay reserved for outcomes.
 */

const ACCENT = 'var(--primary)';
const INK = 'var(--foreground)';
const MUTED = 'var(--muted-foreground)';
const GRID = 'var(--border)';
const HOUR = 3_600_000;

function timeLabel(t: number, spanMs: number): string {
  const date = new Date(t);
  if (spanMs > 36 * HOUR) return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fullTime(t: number): string {
  return new Date(t).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface MarkProps {
  cx?: number;
  cy?: number;
  marker: ThesisMarker;
  selected: boolean;
  onSelect: (id: string) => void;
}

/** A triangle pointing up for YES and down for NO, with a tap target larger than the shape. */
function ThesisMark({ cx, cy, marker, selected, onSelect }: MarkProps) {
  if (cx === undefined || cy === undefined) return null;
  const size = selected ? 8 : 6;
  const direction = marker.side === 'yes' ? -1 : 1;
  const points = [
    `${cx},${cy + direction * size}`,
    `${cx - size},${cy - direction * size * 0.75}`,
    `${cx + size},${cy - direction * size * 0.75}`,
  ].join(' ');
  const who = marker.authorKind === 'agent' ? 'AI' : 'Human';
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${who} thesis for ${marker.side.toUpperCase()}: ${marker.headline}`}
      onClick={() => onSelect(marker.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(marker.id);
        }
      }}
      style={{ cursor: 'pointer' }}
    >
      <circle cx={cx} cy={cy} r={14} fill="transparent" />
      <polygon
        points={points}
        fill={marker.authorKind === 'agent' ? ACCENT : INK}
        stroke="var(--background)"
        strokeWidth={1.5}
      />
    </g>
  );
}

function PriceTooltip({
  active,
  payload,
  series,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
  series: ChartSeries;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-sm shadow-sm">
      <div className="font-medium tabular-nums">
        {series === 'midpoint' ? 'Midpoint' : 'Last trade'} {cents(point.price)}
      </div>
      <div className="text-muted-foreground">{fullTime(point.t)}</div>
    </div>
  );
}

export interface OddsChartProps {
  points: ChartPoint[];
  series: ChartSeries;
  theses: ThesisMarker[];
  selectedThesisId: string | null;
  onSelectThesis: (id: string) => void;
}

export function OddsChart({ points, series, theses, selectedThesisId, onSelectThesis }: OddsChartProps) {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;
  const span = last.t - first.t;
  const marks = theses.filter(
    (marker): marker is ThesisMarker & { t: number; price: number } =>
      marker.t !== null && marker.price !== null,
  );

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={[first.t, last.t]}
          ticks={timeTicks(first.t, last.t)}
          tickFormatter={(t: number) => timeLabel(t, span)}
          tick={{ fill: MUTED, fontSize: 12 }}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          minTickGap={48}
        />
        <YAxis
          domain={[0, 1]}
          ticks={[0, 0.25, 0.5, 0.75, 1]}
          tickFormatter={(price: number) => cents(price)}
          tick={{ fill: MUTED, fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={44}
        />
        <Tooltip content={<PriceTooltip series={series} />} isAnimationActive={false} />
        {/* A quote holds until the next one, so the line moves in steps. */}
        <Line
          dataKey="price"
          type="stepAfter"
          stroke={ACCENT}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
        {marks.map((marker) => (
          <ReferenceDot
            key={marker.id}
            x={Math.min(Math.max(marker.t, first.t), last.t)}
            y={marker.price}
            shape={(props: { cx?: number; cy?: number }) => (
              <ThesisMark
                cx={props.cx}
                cy={props.cy}
                marker={marker}
                selected={marker.id === selectedThesisId}
                onSelect={onSelectThesis}
              />
            )}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
